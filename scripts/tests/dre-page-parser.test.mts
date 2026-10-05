// Parser tests on synthetic pages that reproduce DRE's markup exactly
// (CRLF, unclosed <font>, &nbsp;, split labels, blank-line-separated entries)
// with made-up people, so no real licensee data lives in the repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotARecordPage, parsePage, toDate } from "../lib/dre-page-parser.mts";

type Row = [label: string, cellHtml: string];
const F = (s: string) => `<FONT FACE="Arial,Helvetica" size=2>${s}<br/><br/></font>`;
const L = (label: string) => `<FONT FACE="Arial,Helvetica" size=2><strong>${label}:</strong><font><br/>`;
function page(rows: Row[], opts: { encoding?: "utf-8" | "latin1"; complete?: boolean } = {}): Uint8Array {
  const body = rows.map(([label, cell]) => `<tr valign="top"><td>${label ? L(label) : ""}</td><td>${F(cell)}</td></tr>`).join("");
  const html = [
    `<html xmlns="https://www.w3.org/1999/xhtml"><head><title>Public License Lookup - DRE</title>`,
    `<script>var clicky_site_ids = clicky_site_ids || [];</script></head><body><center><font>`,
    `License information taken from records of the Department of Real Estate on 9/27/2026 1:40:26 PM<hr/></font></center>`,
    `<table border="0" cellspacing="0" cellpadding="2">${body}`,
    opts.complete === false ? "" : `<tr valign="top"><td></td><td>${F(">>>> Public information request complete <<<<")}</td></tr>`,
    `</table></body></html>`,
  ].join("\r\n");
  if (opts.encoding === "latin1") return Uint8Array.from(html, (c) => c.charCodeAt(0) & 0xff);
  return new TextEncoder().encode(html);
}
const base = (license: string, type = "SALESPERSON", status = "LICENSED"): Row[] => [
  ["License Type", type], ["Name", "Doe, Jane Q"], ["Mailing Address", "123 MAIN ST<br/>IRVINE, CA&nbsp;&nbsp;92618"],
  ["License ID", license], ["Expiration Date", "05/30/28"], ["License Status", status],
];

test("salesperson: core fields, wrapped broker name, addresses dropped, history with dates", () => {
  const p = parsePage(page([
    ...base("01234567"),
    ["Salesperson License Issued", "04/07/88&nbsp;&nbsp;&nbsp;&nbsp;(Unofficial -- taken from secondary records)"],
    ["Former Name(s)", "NO FORMER NAMES"],
    ["Responsible Broker", `License ID: <a href = "pplinfo.asp?License_id=00616212">00616212 </a><br/>Coldwell Banker Residential<br/>Brokerage Company<br/>1109 QUAIL ST<br/>STE150<br/>NEWPORT BEACH, CA  92660`],
    ["Former Responsible Broker", `License ID: <a href = "pplinfo.asp?License_id=01991628">01991628 </a><br/>Compass California, Inc.<br/>From 03/28/2022 to 01/03/2024<br/><br/>License ID: <a href = "pplinfo.asp?License_id=01978276">01978276 </a><br/>999 Investments, Inc<br/>From 05/28/2020 to 02/20/2022`],
    ["Comment", "NO DISCIPLINARY ACTION"], ["", "NO OTHER PUBLIC COMMENTS"],
  ]), "01234567");
  assert.equal(p.record.license_type, "SALESPERSON");
  assert.equal(p.record.name_as_listed, "Doe, Jane Q");
  assert.equal(p.record.expiration_date, "2028-05-30");
  assert.equal(p.record.salesperson_license_issued, "1988-04-07");
  assert.equal(p.record.issued_dates_unofficial, true);
  assert.equal(p.record.dre_records_as_of, "9/27/2026 1:40:26 PM");
  assert.deepEqual(p.record.unparsed_lines, []);
  assert.deepEqual(p.affiliations.map((a) => [a.kind, a.is_current, a.related_license_number, a.related_name, a.from_date, a.to_date]), [
    ["responsible_broker", true, "00616212", "Coldwell Banker Residential Brokerage Company", null, null],
    ["responsible_broker", false, "01991628", "Compass California, Inc.", "2022-03-28", "2024-01-03"],
    ["responsible_broker", false, "01978276", "999 Investments, Inc", "2020-05-28", "2022-02-20"],
  ]);
  assert.ok(!JSON.stringify(p).includes("QUAIL"), "addresses never reach processed rows");
  assert.ok(!JSON.stringify(p).includes("MAIN ST"));
});

test("restricted broker: officer roles (expired, canceled, restriction notes), discipline, documents", () => {
  const p = parsePage(page([
    ...base("00323437", "BROKER", "LICENSED NBA *** RESTRICTED ***"),
    ["Broker License Issued", "01/07/81"],
    ["Affiliated Licensed Corporation(s)", `<A HREF = "/publicasp/pplinfo.asp?License_id=00754138">00754138</A> - Officer Expiration Date: 07/02/94<br/>Veteran Real Estate<br/>Inc<br/>**THIS OFFICER IS RESTRICTED. THIS CORP IS NOT RESTRICTED.**<br/>OFFICER LICENSE EXPIRED AS OF 07/03/94`],
    ["", `<A HREF = "/publicasp/pplinfo.asp?License_id=01472367">01472367</A> - Officer Expiration Date: 03/16/13<br/>Towne & Country Properties Inc<br/>OFFICER CANCELED AS OF 01/11/11`],
    ["", `<A HREF = "/publicasp/pplinfo.asp?License_id=02208410">02208410</A> - Officer Expiration Date: 03/09/27<br/>Pioneer Home Inc`],
    ["Comment", "06/13/85 - H-460 SA"], ["", "07/03/86 - REVOKE WITH R TO RL ON T&amp;C"], ["", "NO OTHER PUBLIC COMMENTS"],
    ["Disciplinary or Formal Action<br/>Documents", `<A HREF = "/hearingfiles/H00460SA_P.pdf" target="_blank">H00460SA_P.pdf</a>`],
  ]), "00323437");
  assert.equal(p.record.is_restricted, true);
  assert.equal(p.record.is_non_working, true);
  assert.equal(p.record.broker_license_issued, "1981-01-07");
  const officers = p.affiliations.filter((a) => a.kind === "officer_of_corporation");
  assert.deepEqual(officers.map((a) => [a.related_license_number, a.related_name, a.is_current, a.ended_status, a.ended_on, a.related_expiration_date]), [
    ["00754138", "Veteran Real Estate Inc", false, "expired", "1994-07-03", "1994-07-02"],
    ["01472367", "Towne & Country Properties Inc", false, "canceled", "2011-01-11", "2013-03-16"],
    ["02208410", "Pioneer Home Inc", true, null, null, "2027-03-09"],
  ]);
  assert.equal(officers[0].officer_restricted, true);
  assert.equal(officers[0].corporation_restricted, false);
  assert.deepEqual(p.actions.map((a) => [a.kind, a.action_date, a.text_verbatim, a.document_url]), [
    ["comment", "1985-06-13", "H-460 SA", null],
    ["comment", "1986-07-03", "REVOKE WITH R TO RL ON T&C", null],
    ["document", null, "H00460SA_P.pdf", "https://www2.dre.ca.gov/hearingfiles/H00460SA_P.pdf"],
  ]);
  assert.deepEqual(p.record.unparsed_lines, []);
});

test("broker lists, DBAs with date ranges and wrapped names, NMLS, branch manager", () => {
  const p = parsePage(page([
    ...base("00167110", "BROKER"),
    ["MLO License Endorsement", `NMLS ID: 255265 (Click <a href="http://www.nmlsconsumeraccess.org/x/255265">here</a> to check the status of the MLO License Endorsement )`],
    ["Company MLO License Endorsement", "2223463 (Click here to check the status of the MLO License Endorsement.)"],
    ["DBA", "D &amp; S Real Estate Investment And<br/>Financing, Development<br/>ACTIVE FROM 11/02/1990 TO 03/18/2013<br/><br/>Berge Company<br/>ACTIVE AS OF 09/30/1987"],
    ["Branches", "NO CURRENT BRANCHES"],
    ["Branch/Division Manager for", `<a href="pplinfo.asp?License_id=01317331">01317331</a> - Pickford Real Estate<br/>Brokerage Company<br/>30812 SOUTH COAST HWY<br/>LAGUNA BEACH, CA  92651`],
    ["Salespersons", `02069138 - Bailey, Amy Nicole<br/>&nbsp;&nbsp;&nbsp;&nbsp;License Expiration Date: 08/22/2030<br/><br/>01718214 - Zhao, Hang<br/>&nbsp;&nbsp;License Expiration Date: 04/21/2030`],
    ["Broker Associates", `00889827 - Berge, Michael Joseph<br/>License Expiration Date: 04/18/2029`],
  ]), "00167110");
  assert.equal(p.record.mlo_nmls_id, "255265");
  assert.equal(p.record.company_mlo_nmls_id, "2223463");
  const by = (k: string) => p.affiliations.filter((a) => a.kind === k);
  assert.deepEqual(by("dba").map((a) => [a.related_name, a.is_current, a.from_date, a.to_date]), [
    ["D & S Real Estate Investment And Financing, Development", false, "1990-11-02", "2013-03-18"],
    ["Berge Company", true, "1987-09-30", null],
  ]);
  assert.deepEqual(by("branch_manager_for").map((a) => [a.related_license_number, a.related_name]), [["01317331", "Pickford Real Estate Brokerage Company"]]);
  assert.deepEqual(by("supervised_salesperson").map((a) => [a.related_license_number, a.related_name, a.related_expiration_date]), [
    ["02069138", "Bailey, Amy Nicole", "2030-08-22"], ["01718214", "Zhao, Hang", "2030-04-21"],
  ]);
  assert.deepEqual(by("supervised_broker_associate").map((a) => [a.related_license_number, a.related_expiration_date]), [["00889827", "2029-04-18"]]);
  assert.deepEqual(p.record.unparsed_lines, []);
  assert.ok(!JSON.stringify(p).includes("SOUTH COAST"));
});

test("expiration notes, status variants, former names", () => {
  const rows = base("02000001", "SALESPERSON", "LICENSED NBA");
  rows[4] = ["Expiration Date", "07/21/26 - License Extension granted through 10/19/26"];
  const p = parsePage(page([...rows, ["Former Name(s)", "Smith, Jane<br/><br/>Jones, Jane Q"]]), "02000001");
  assert.equal(p.record.expiration_date, "2026-07-21");
  assert.equal(p.record.expiration_note, "License Extension granted through 10/19/26");
  assert.equal(p.record.is_non_working, true);
  assert.equal(p.record.is_restricted, false);
  assert.deepEqual(p.record.former_names, ["Smith, Jane", "Jones, Jane Q"]);
});

test("two-digit years: past issue dates are 1900s, near-future expirations are 2000s", () => {
  assert.equal(toDate("10/30/66"), "1966-10-30");
  assert.equal(toDate("04/12/85"), "1985-04-12");
  assert.equal(toDate("01/15/29"), "2029-01-15");
  assert.equal(toDate("08/22/2030"), "2030-08-22");
  assert.equal(toDate("no date"), null);
});

test("Windows-1252 pages decode correctly", () => {
  const rows = base("00000042");
  rows[1] = ["Name", "Magaña, José"];
  const p = parsePage(page(rows, { encoding: "latin1" }), "00000042");
  assert.equal(p.record.name_as_listed, "Magaña, José");
  assert.equal(p.record.page_encoding, "windows-1252");
});

test("unknown labels and unexpected lines are kept verbatim, never dropped", () => {
  const p = parsePage(page([...base("01111111"), ["Some New Section", "Brand new line"], ["Former Responsible Broker", "License ID: 00000001<br/>Acme Inc<br/>From 01/01/2020 to 01/01/2021<br/>WEIRD TRAILING NOTE"]]), "01111111");
  assert.deepEqual(p.record.unparsed_lines, [
    { label: "Former Responsible Broker", line: "WEIRD TRAILING NOTE" },
    { label: "Some New Section", line: "Brand new line" },
  ]);
});

test("refuses pages that aren't the requested license's complete record", () => {
  assert.throws(() => parsePage(page(base("01234567"), { complete: false }), "01234567"), NotARecordPage);
  assert.throws(() => parsePage(page(base("01234567")), "07654321"), /page shows license 01234567/);
  const nf = new TextEncoder().encode("<html><body>No matching public record was found for License ID: 99999999. >>>> Public information request complete <<<<</body></html>");
  assert.throws(() => parsePage(nf, "99999999"), NotARecordPage);
});
