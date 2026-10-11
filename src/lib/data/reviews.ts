// Reviews, comments, reactions and reports, built on the generic repository.
// The database enforces the rules (Row Level Security + constraints): posting
// requires a signed-in user, the Buyer/Seller tag and a 1-5 rating are
// required, authors may only edit their own posts, etc.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types";
import { createReader, createRepository, DataError, type Insert, type Row } from "./repository.ts";

type Db = SupabaseClient<Database>;

async function currentUserId(db: Db): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) throw new DataError("you need to be signed in", "not_signed_in");
  return data.user.id;
}

export async function postReview(db: Db, input: Pick<Insert<"reviews">, "realtor_license_number" | "relationship_tag" | "rating" | "body">) {
  const [review] = await createRepository(db, "reviews").insert({ ...input, author_id: await currentUserId(db) });
  return review;
}

export async function editReview(db: Db, id: string, patch: Partial<Pick<Insert<"reviews">, "rating" | "body" | "relationship_tag">>) {
  const rows = await createRepository(db, "reviews").update({ id }, patch);
  if (!rows.length) throw new DataError("review not found or not yours to edit", "not_found");
  return rows[0];
}

// Author deletes keep the row (shown as "[deleted]") so replies stay threaded.
export async function deleteReview(db: Db, id: string) {
  const { error } = await db.rpc("delete_own_review", { p_review_id: id });
  if (error) throw new DataError(error.message, error.code);
}

export async function postComment(db: Db, input: { review_id: string; body: string; parent_comment_id?: string | null }) {
  const [comment] = await createRepository(db, "comments").insert({ ...input, author_id: await currentUserId(db) });
  return comment;
}

export async function deleteComment(db: Db, id: string) {
  const { error } = await db.rpc("delete_own_comment", { p_comment_id: id });
  if (error) throw new DataError(error.message, error.code);
}

export function listComments(db: Db, reviewId: string): Promise<Row<"comment_feed">[]> {
  return createReader(db, "comment_feed").list({ match: { review_id: reviewId }, order: { column: "created_at" } });
}

// Like = 1, dislike = -1, null = clear. One reaction per user per review.
export async function reactToReview(db: Db, reviewId: string, value: 1 | -1 | null) {
  const user_id = await currentUserId(db);
  const reactions = createRepository(db, "review_reactions");
  const existing = await reactions.get({ review_id: reviewId, user_id });
  if (value === null) { if (existing) await reactions.remove({ review_id: reviewId, user_id }); return; }
  if (existing) await reactions.update({ review_id: reviewId, user_id }, { value });
  else await reactions.insert({ review_id: reviewId, user_id, value });
}

export async function reactToComment(db: Db, commentId: string, value: 1 | -1 | null) {
  const user_id = await currentUserId(db);
  const reactions = createRepository(db, "comment_reactions");
  const existing = await reactions.get({ comment_id: commentId, user_id });
  if (value === null) { if (existing) await reactions.remove({ comment_id: commentId, user_id }); return; }
  if (existing) await reactions.update({ comment_id: commentId, user_id }, { value });
  else await reactions.insert({ comment_id: commentId, user_id, value });
}

// Reported content stays visible pending moderator review (PRD REQ-010).
export async function reportContent(db: Db, target: { review_id: string } | { comment_id: string },
  reason: Insert<"reports">["reason"], notes?: string) {
  const [report] = await createRepository(db, "reports").insert({
    target_type: "review_id" in target ? "review" : "comment",
    review_id: "review_id" in target ? target.review_id : null,
    comment_id: "comment_id" in target ? target.comment_id : null,
    reporter_id: await currentUserId(db), reason, notes: notes ?? null,
  });
  return report;
}
