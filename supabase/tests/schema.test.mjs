// Behavioral tests for the SQL migrations, run in-process with PGlite (no
// Docker or live Supabase needed). Supabase's auth/storage schemas and roles
// are stubbed below. Usage: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../migrations/', import.meta.url);
const migration = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
const db = new PGlite({ extensions: { pg_trgm, citext } });

// Minimal Supabase stand-ins.
await db.exec(`
  create schema extensions; create schema auth; create schema storage;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, extensions, auth, storage to anon, authenticated;
  create table auth.users (id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  set search_path = public, extensions;
`);
await db.exec(migration);
console.log('migration applied');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ', name); }
  else { fail++; console.log('  FAIL ', name, extra); }
};
async function as(uid, sql, params = []) {
  // uid: null => anon
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('role', $1, true)`, [uid ? 'authenticated' : 'anon']);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    await tx.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
    return tx.query(sql, params);
  });
}
async function fails(uid, sql, params = []) {
  try { await as(uid, sql, params); return false; } catch (e) { return e.message; }
}

// Users.
const users = {};
for (const name of ['alice', 'bob', 'mod', 'rep1', 'rep2', 'rep3', 'rep4', 'rep5']) {
  const { rows } = await db.query(
    `insert into auth.users (raw_user_meta_data) values (jsonb_build_object('username', $1::text)) returning id`, [name]);
  users[name] = rows[0].id;
}
await db.query(`update profiles set role = 'moderator' where id = $1`, [users.mod]);
ok('profile auto-created', (await db.query(`select count(*)::int n from profiles`)).rows[0].n === 8);
ok('bad username rejects signup', !!(await db.query(
  `insert into auth.users (raw_user_meta_data) values ('{"username":"no spaces!"}')`).then(() => false, () => true)));
ok('duplicate username (case-insensitive) rejects', !!(await db.query(
  `insert into auth.users (raw_user_meta_data) values ('{"username":"ALICE"}')`).then(() => false, () => true)));
ok('username_available', (await as(null, `select username_available('Alice') a, username_available('carol') b`)).rows[0].a === false);

// Realtors (service-role style write).
await db.exec(`
  insert into realtors (license_number, last_name, first_name, license_type, license_status,
    employing_broker_license_number, employing_broker_name, city, county)
  values ('00221331', 'Hill', 'Edward James', 'salesperson', 'Licensed', '00616212',
          'Coldwell Banker Residential Brokerage Company', 'CORONA DEL MAR', 'ORANGE'),
         ('00007012', 'Delanoy', 'Peter Nelson', 'broker', 'Licensed', null, null, 'IRVINE', 'ORANGE');
`);
ok('anon can search realtors (FTS)', (await as(null,
  `select license_number from realtors where search_vector @@ plainto_tsquery('simple','coldwell')`)).rows.length === 1);
ok('anon can search realtors (trigram)', (await as(null,
  `select license_number from realtors where full_name % 'Edwerd Hill'`)).rows.length === 1);
ok('anon cannot write realtors', !!(await fails(null, `update realtors set last_name='x'`)));
await db.exec(`update realtors set employing_broker_name = 'Compass', last_name = 'Hill' where license_number = '00221331'`);
const hist = (await db.query(`select * from realtor_history`)).rows;
ok('realtor change logged (only changed fields)', hist.length === 1 && Object.keys(hist[0].new_values).join() === 'employing_broker_name');

// Reviews.
const R = '00221331';
ok('anon cannot post review', !!(await fails(null,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body) values ($1, null, 'buyer', 5, 'x')`, [R])));
ok('review without tag rejected', !!(await fails(users.alice,
  `insert into reviews (realtor_license_number, author_id, rating, body) values ($1, $2, 5, 'x')`, [R, users.alice])));
ok('review rating out of range rejected', !!(await fails(users.alice,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body) values ($1, $2, 'buyer', 6, 'x')`, [R, users.alice])));
ok('cannot self-verify on insert', !!(await fails(users.alice,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body, is_verified_client) values ($1, $2, 'buyer', 5, 'x', true)`, [R, users.alice])));
ok('cannot post as someone else', !!(await fails(users.alice,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body) values ($1, $2, 'buyer', 5, 'x')`, [R, users.bob])));
const rev = (await as(users.alice,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body) values ($1, $2, 'buyer', 2, 'Slow to respond.') returning id`,
  [R, users.alice])).rows[0].id;
const rev2 = (await as(users.alice,
  `insert into reviews (realtor_license_number, author_id, relationship_tag, rating, body) values ($1, $2, 'seller', 4, 'Sold fast.') returning id`,
  [R, users.alice])).rows[0].id;
ok('multiple reviews per user allowed', !!rev2);
ok('author cannot self-verify via update', !!(await fails(users.alice, `update reviews set is_verified_client = true where id = $1`, [rev])));
ok('author cannot change status via update', !!(await fails(users.alice, `update reviews set status = 'removed' where id = $1`, [rev])));
await as(users.alice, `update reviews set body = 'Slow to respond, twice.' where id = $1`, [rev]);
ok('edit stamps edited_at', (await db.query(`select edited_at from reviews where id = $1`, [rev])).rows[0].edited_at !== null);
const bobEdit = await as(users.bob, `update reviews set body = 'hacked' where id = $1 returning id`, [rev]);
ok("other user can't edit review", bobEdit.rows.length === 0);
ok('anon cannot read base reviews table', !!(await fails(null, `select * from reviews`)));
ok('anon reads review_feed', (await as(null, `select * from review_feed where realtor_license_number = $1`, [R])).rows.length === 2);

// Comments (nested).
const c1 = (await as(users.bob, `insert into comments (review_id, author_id, body) values ($1, $2, 'Same experience.') returning id`,
  [rev, users.bob])).rows[0].id;
const c2 = (await as(users.alice, `insert into comments (review_id, parent_comment_id, author_id, body) values ($1, $2, $3, 'Really?') returning id`,
  [rev, c1, users.alice])).rows[0].id;
ok('nested reply on other user comment', !!c2);
ok('reply parent from different review rejected', !!(await fails(users.bob,
  `insert into comments (review_id, parent_comment_id, author_id, body) values ($1, $2, $3, 'x')`, [rev2, c1, users.bob])));
ok('comment_count maintained', (await db.query(`select comment_count from reviews where id = $1`, [rev])).rows[0].comment_count === 2);
ok('comments table has no relationship_tag',
  (await db.query(`select 1 from information_schema.columns where table_name='comments' and column_name='relationship_tag'`)).rows.length === 0);

// Reactions.
await as(users.bob, `insert into review_reactions (review_id, user_id, value) values ($1, $2, 1)`, [rev, users.bob]);
await as(users.rep1, `insert into review_reactions (review_id, user_id, value) values ($1, $2, -1)`, [rev, users.rep1]);
await as(users.bob, `update review_reactions set value = -1 where review_id = $1 and user_id = $2`, [rev, users.bob]);
let rc = (await db.query(`select like_count, dislike_count from reviews where id = $1`, [rev])).rows[0];
ok('reaction counts after switch', rc.like_count === 0 && rc.dislike_count === 2, JSON.stringify(rc));
ok('one reaction per user', !!(await fails(users.bob, `insert into review_reactions (review_id, user_id, value) values ($1, $2, 1)`, [rev, users.bob])));
await as(users.bob, `delete from review_reactions where review_id = $1 and user_id = $2`, [rev, users.bob]);
rc = (await db.query(`select like_count, dislike_count from reviews where id = $1`, [rev])).rows[0];
ok('reaction counts after delete', rc.dislike_count === 1);
await as(users.bob, `insert into comment_reactions (comment_id, user_id, value) values ($1, $2, 1)`, [c2, users.bob]);
ok('comment like count', (await db.query(`select like_count from comments where id = $1`, [c2])).rows[0].like_count === 1);

// Rating summary.
const sum = (await as(null, `select * from realtor_rating_summary where realtor_license_number = $1`, [R])).rows[0];
ok('rating summary', sum.review_count === 2 && Number(sum.average_rating) === 3, JSON.stringify(sum));

// Reports + auto-hide at 5 distinct reporters.
const reporters = ['bob', 'rep1', 'rep2', 'rep3'];
for (const u of reporters) {
  await as(users[u], `insert into reports (target_type, review_id, reporter_id, reason) values ('review', $1, $2, 'threatening')`, [rev, users[u]]);
}
ok('duplicate report by same user rejected', !!(await fails(users.bob,
  `insert into reports (target_type, review_id, reporter_id, reason) values ('review', $1, $2, 'spam')`, [rev, users.bob])));
ok('4 reports: still visible', (await db.query(`select status from reviews where id = $1`, [rev])).rows[0].status === 'visible');
await as(users.rep4, `insert into reports (target_type, review_id, reporter_id, reason) values ('review', $1, $2, 'private_information')`, [rev, users.rep4]);
ok('5 reports: hidden pending review', (await db.query(`select status from reviews where id = $1`, [rev])).rows[0].status === 'hidden_pending_review');
const masked = (await as(null, `select body, rating, author_username, status from review_feed where id = $1`, [rev])).rows[0];
ok('feed masks hidden review', masked.body === null && masked.rating === null && masked.author_username === null);
ok('hidden review excluded from average', (await db.query(`select review_count from realtor_rating_summary`)).rows[0].review_count === 1);
ok('cannot comment on hidden review', !!(await fails(users.bob, `insert into comments (review_id, author_id, body) values ($1, $2, 'x')`, [rev, users.bob])));
// Spam reports never auto-hide.
for (const u of ['bob', 'rep1', 'rep2', 'rep3', 'rep4']) {
  await as(users[u], `insert into reports (target_type, review_id, reporter_id, reason) values ('review', $1, $2, 'spam')`, [rev2, users[u]]);
}
ok('5 spam reports: still visible', (await db.query(`select status from reviews where id = $1`, [rev2])).rows[0].status === 'visible');
ok('reporter sees only own reports', (await as(users.bob, `select * from reports`)).rows.length === 2);
ok('cannot file pre-resolved report', !!(await fails(users.rep5,
  `insert into reports (target_type, review_id, reporter_id, reason, status) values ('review', $1, $2, 'spam', 'dismissed')`, [rev, users.rep5])));

// Moderation.
ok('non-moderator cannot moderate', !!(await fails(users.alice, `select moderate_content('review', $1, 'dismiss_report')`, [rev])));
ok('moderator sees queue', (await as(users.mod, `select * from reports where status = 'open'`)).rows.length === 10);
await as(users.mod, `select moderate_content('review', $1, 'dismiss_report', 'Negative but not a threat')`, [rev]);
ok('dismiss restores visibility', (await db.query(`select status from reviews where id = $1`, [rev])).rows[0].status === 'visible');
ok('dismiss closes reports', (await db.query(`select count(*)::int n from reports where review_id = $1 and status = 'dismissed'`, [rev])).rows[0].n === 5);
await as(users.mod, `select moderate_content('comment', $1, 'remove', 'Doxxing')`, [c1]);
const cm = (await as(null, `select body, status from comment_feed where id = $1`, [c1])).rows[0];
ok('removed comment masked, row kept', cm.body === null && cm.status === 'removed');
ok('reply under removed comment still present', (await as(null, `select body from comment_feed where id = $1`, [c2])).rows[0].body === 'Really?');
await as(users.mod, `select moderate_content('review', $1, 'label', null, 'Disputed by other users')`, [rev2]);
ok('label applied', (await as(null, `select moderator_label from review_feed where id = $1`, [rev2])).rows[0].moderator_label === 'Disputed by other users');
ok('moderation logged', (await as(users.mod, `select count(*)::int n from moderation_actions`)).rows[0].n === 3);
ok('non-moderator cannot read moderation log', (await as(users.alice, `select * from moderation_actions`)).rows.length === 0);

// Documents + verification.
ok('document path must be own folder', !!(await fails(users.alice,
  `insert into review_documents (review_id, uploader_id, storage_path, mime_type, size_bytes) values ($1, $2, 'someone/x.pdf', 'application/pdf', 100)`, [rev, users.alice])));
await as(users.alice,
  `insert into review_documents (review_id, uploader_id, storage_path, mime_type, size_bytes) values ($1, $2, $3, 'application/pdf', 100)`,
  [rev, users.alice, `${users.alice}/${rev}/closing.pdf`]);
ok('upload does not verify', (await db.query(`select is_verified_client from reviews where id = $1`, [rev])).rows[0].is_verified_client === false);
ok('author cannot read documents back', (await as(users.alice, `select * from review_documents`)).rows.length === 0);
ok('moderator reads documents', (await as(users.mod, `select * from review_documents`)).rows.length === 1);
ok('non-moderator cannot verify', !!(await fails(users.alice, `select set_verified_client($1, true)`, [rev])));
await as(users.mod, `select set_verified_client($1, true, 'Closing disclosure matches')`, [rev]);
ok('moderator verifies', (await as(null, `select is_verified_client from review_feed where id = $1`, [rev])).rows[0].is_verified_client === true);

// Author delete.
ok('other user cannot delete', !!(await fails(users.bob, `select delete_own_review($1)`, [rev2])));
await as(users.alice, `select delete_own_comment($1)`, [c2]);
const dc = (await as(null, `select body, status from comment_feed where id = $1`, [c2])).rows[0];
ok('author delete masks comment', dc.body === null && dc.status === 'deleted_by_author');
await as(users.alice, `select delete_own_review($1)`, [rev]);
ok('restore does not resurrect author-deleted', !!(await as(users.mod, `select moderate_content('review', $1, 'restore')`, [rev]))
  && (await db.query(`select status from reviews where id = $1`, [rev])).rows[0].status === 'deleted_by_author');

// Property cache.
await db.exec(`insert into properties (apn, address_normalized, address_display) values ('123-456-78', '1 MAIN ST IRVINE CA 92618', '1 Main St, Irvine, CA 92618')`);
await db.exec(`insert into property_source_data (property_id, source, payload, source_url, expires_at)
  select id, 'fema_flood', '{"zone":"X"}', 'https://msc.fema.gov/', now() + interval '9 months' from properties`);
ok('anon reads property cache', (await as(null, `select * from property_source_data`)).rows.length === 1);
ok('anon cannot write property cache', !!(await fails(null, `insert into properties (address_normalized, address_display) values ('a','a')`)));
ok('authenticated cannot write property cache', !!(await fails(users.alice, `delete from property_source_data returning 1`).then(async (m) => m || ((await db.query('select count(*)::int n from property_source_data')).rows[0].n === 1))));
ok('address trigram search', (await as(null, `select id from properties where address_normalized % '1 MAIN STREET IRVINE'`)).rows.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
