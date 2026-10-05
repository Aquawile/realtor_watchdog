// Processed layer: raw DRE licensee page -> relational rows.
//
// Designed from a field survey of all 44,354 stored pages (2026-10-05). Keeps
// DRE's exact wording wherever something is interpreted (raw_text,
// text_verbatim, license_status_raw), drops addresses (privacy), and never
// silently loses a line: anything not placed lands in unparsed_lines.

import { clean, readPage, type Entry } from "./dre-page-html.mts";

export const PARSER_VERSION = 1;
const DRE_BASE = "https://www2.dre.ca.gov";

export type LicenseeRecord = {
  license_number: string;
  dre_records_as_of: string | null;        // DRE's own timestamp text (Pacific time)
  page_encoding: string;
  license_type: string;                    // verbatim: BROKER / SALESPERSON
  name_as_listed: string;
  license_status_raw: string;              // verbatim, e.g. "LICENSED NBA *** RESTRICTED ***"
  is_restricted: boolean;
  is_non_working: boolean;                 // "NBA": may not perform licensed acts
  expiration_date: string | null;
  expiration_note: string | null;          // e.g. "License Extension granted through 10/19/26"
  salesperson_license_issued: string | null;
  broker_license_issued: string | null;
  issued_dates_unofficial: boolean;        // DRE: "Unofficial -- taken from secondary records"
  mlo_nmls_id: string | null;
  company_mlo_nmls_id: string | null;
  former_names: string[];
  unparsed_lines: { label: string; line: string }[];
};

export type AffiliationKind =
  | "responsible_broker" | "broker_associate_for" | "officer_of_corporation" | "branch_manager_for"
  | "supervised_salesperson" | "supervised_broker_associate" | "dba";

export type Affiliation = {
  seq: number;
  kind: AffiliationKind;
  is_current: boolean;
  related_license_number: string | null;
  related_name: string | null;
  from_date: string | null;
  to_date: string | null;
  related_expiration_date: string | null;
  ended_status: "expired" | "canceled" | null;   // officer roles
  ended_on: string | null;
  officer_restricted: boolean | null;
  corporation_restricted: boolean | null;
  raw_text: string;                              // DRE's lines for this entry, addresses removed
};

export type Action = {
  seq: number;
  kind: "comment" | "document";
  action_date: string | null;
  text_verbatim: string;
  document_url: string | null;
};

export type ParsedPage = { record: LicenseeRecord; affiliations: Affiliation[]; actions: Action[] };

// DRE writes most dates as MM/DD/YY. Two-digit years more than 10 years in the
// future are 1900s (licenses issued in 1966 vs expiring in 2030).
const THIS_YEAR = new Date().getUTCFullYear();
export function toDate(s: string | null | undefined): string | null {
  const m = s?.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (!m) return null;
  let y = Number(m[3]);
  if (m[3].length === 2) y = 2000 + y > THIS_YEAR + 10 ? 1900 + y : 2000 + y;
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const NONE = /^NO (CURRENT|FORMER|OTHER|DISCIPLINARY)\b/i;
const END_MARKER = /Public information request complete/i;
// Street / suite / city lines that follow a related licensee's name.
const isAddress = (l: string) =>
  /^\d/.test(l) ||
  /^(SUITE|STE|UNIT|BLDG|BUILDING|APT|FLOOR|FL|RM|ROOM|OFFICE|SPC|SPACE|#|PMB)(\s|\d|#|-|$)/i.test(l) || // "STE150", "OFFICE 1132"
  /^[A-Z]{1,2}\s?\d{1,5}$/.test(l) || // unit designators like "H 628"
  /^P\.?\s?O\.?\s?BOX\b/i.test(l) ||
  /, [A-Z]{2}\s+\d{5}(-\d{4})?$/.test(l);

export class NotARecordPage extends Error {}

export function parsePage(bytes: Uint8Array, expectedLicense: string): ParsedPage {
  const page = readPage(bytes);
  if (!page.complete || page.notFound) throw new NotARecordPage(`${expectedLicense}: not a complete record page`);
  const fields = page.fields;
  const unparsed: { label: string; line: string }[] = [];
  const take = (label: string) => { const e = fields.get(label) ?? []; fields.delete(label); return e; };
  const firstLine = (label: string) => {
    const es = take(label);
    es.flatMap((e) => e.lines).slice(1).forEach((line) => unparsed.push({ label, line }));
    return es[0]?.lines[0] ?? null;
  };
  const keepUnused = (label: string, e: Entry, used: Set<number>) =>
    e.lines.forEach((line, i) => { if (!used.has(i)) unparsed.push({ label, line }); });

  // ---- one-per-licensee facts ------------------------------------------------
  const licenseNumber = firstLine("License ID")?.match(/\d{8}/)?.[0] ?? null;
  if (licenseNumber !== expectedLicense) throw new NotARecordPage(`${expectedLicense}: page shows license ${licenseNumber}`);
  const status = firstLine("License Status") ?? "";
  const expiration = firstLine("Expiration Date");
  const salesIssued = firstLine("Salesperson License Issued");
  const brokerIssued = firstLine("Broker License Issued");
  const mlo = take("MLO License Endorsement").flatMap((e) => e.lines);
  const companyMlo = take("Company MLO License Endorsement").flatMap((e) => e.lines);
  for (const l of ["Mailing Address", "Main Office", "Branches"]) take(l); // addresses: dropped on purpose

  const expDate = toDate(expiration);
  const record: LicenseeRecord = {
    license_number: licenseNumber,
    dre_records_as_of: page.recordsAsOf,
    page_encoding: page.encoding,
    license_type: firstLine("License Type") ?? "",
    name_as_listed: firstLine("Name") ?? "",
    license_status_raw: status,
    is_restricted: /RESTRICTED/i.test(status),
    is_non_working: /\bNBA\b/.test(status),
    expiration_date: expDate,
    // "07/21/26 - License Extension granted through 10/19/26" / "Temporary License issued through 01/04/27"
    expiration_note: expiration && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(expiration) ? expiration.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*/, "") : null,
    salesperson_license_issued: toDate(salesIssued),
    broker_license_issued: toDate(brokerIssued),
    issued_dates_unofficial: /Unofficial/i.test(`${salesIssued ?? ""} ${brokerIssued ?? ""}`),
    mlo_nmls_id: mlo.join(" ").match(/NMLS ID:\s*(\d+)/)?.[1] ?? null,
    company_mlo_nmls_id: companyMlo.join(" ").match(/^(\d+)/)?.[1] ?? null,
    former_names: take("Former Name(s)").flatMap((e) => e.lines).filter((l) => !NONE.test(l)),
    unparsed_lines: unparsed,
  };
  for (const l of mlo) if (!/NMLS ID:\s*\d+/.test(l) && !/check the status/i.test(l)) unparsed.push({ label: "MLO License Endorsement", line: l });

  // ---- affiliations ----------------------------------------------------------
  const affiliations: Affiliation[] = [];
  const push = (a: Omit<Affiliation, "seq">) => affiliations.push({ ...a, seq: affiliations.length + 1 });

  // Entries shaped: "License ID: 01234567" | "01234567 - Name" | "01234567 - Officer Expiration Date: MM/DD/YY",
  // then name lines (wrapped names continue), then From/To, status notes, addresses.
  const affil = (label: string, kind: AffiliationKind, current: boolean) => {
    for (const e of take(label)) {
      if (NONE.test(e.lines[0]) || END_MARKER.test(e.lines[0])) {
        e.lines.slice(1).forEach((line) => { if (!END_MARKER.test(line) && !NONE.test(line)) unparsed.push({ label, line }); });
        continue;
      }
      const used = new Set<number>();
      let lic: string | null = e.links.map((l) => l.href.match(/License_id=(\d{8})/i)?.[1]).find(Boolean) ?? null;
      let name: string | null = null, nameDone = false;
      let from: string | null = null, to: string | null = null, relExp: string | null = null;
      let endedStatus: Affiliation["ended_status"] = null, endedOn: string | null = null;
      let offR: boolean | null = null, corpR: boolean | null = null;
      e.lines.forEach((l, i) => {
        let m: RegExpMatchArray | null;
        if ((m = l.match(/^License ID:\s*(\d{8})$/))) { lic ??= m[1]; used.add(i); return; }
        if ((m = l.match(/^(\d{8}) - Officer Expiration Date:\s*(.+)$/))) { lic ??= m[1]; relExp = toDate(m[2]); used.add(i); return; }
        if ((m = l.match(/^(\d{8}) - (.+)$/))) { lic ??= m[1]; name = m[2]; used.add(i); return; }
        if ((m = l.match(/^From (\S+) to (\S+)$/i))) { from = toDate(m[1]); to = toDate(m[2]); nameDone = true; used.add(i); return; }
        if ((m = l.match(/^License Expiration Date:\s*(\S+)$/i))) { relExp = toDate(m[1]); nameDone = true; used.add(i); return; }
        if ((m = l.match(/^OFFICER (LICENSE EXPIRED|CANCELED|LICENSE CANCELED) AS OF (\S+)$/i))) {
          endedStatus = /CANCEL/i.test(m[1]) ? "canceled" : "expired"; endedOn = toDate(m[2]); nameDone = true; used.add(i); return;
        }
        if ((m = l.match(/^\*\*THIS OFFICER IS (NOT )?RESTRICTED\. THIS CORP IS (NOT )?RESTRICTED\.\*\*$/i))) {
          offR = !m[1]; corpR = !m[2]; nameDone = true; used.add(i); return;
        }
        if (!nameDone && (name === null || !isAddress(l))) {
          // First line after the license number is always the name (even "999 Investments, Inc").
          name = name === null ? l : `${name} ${l}`; used.add(i); return;
        }
        nameDone = true;
        if (isAddress(l)) used.add(i); // related licensee's address: dropped
      });
      keepUnused(label, e, used);
      push({
        kind, is_current: kind === "officer_of_corporation" ? endedStatus === null : current,
        related_license_number: lic, related_name: name, from_date: from, to_date: to,
        related_expiration_date: relExp, ended_status: endedStatus, ended_on: endedOn,
        officer_restricted: offR, corporation_restricted: corpR,
        raw_text: e.lines.filter((l, i) => used.has(i) && !isAddress(l)).join(" | "),
      });
    }
  };
  affil("Responsible Broker", "responsible_broker", true);
  affil("Former Responsible Broker", "responsible_broker", false);
  affil("Broker Associate for", "broker_associate_for", true);
  affil("Former Broker Associate for", "broker_associate_for", false);
  affil("Affiliated Licensed Corporation(s)", "officer_of_corporation", true);
  affil("Branch/Division Manager for", "branch_manager_for", true);
  affil("Salespersons", "supervised_salesperson", true);
  affil("Broker Associates", "supervised_broker_associate", true);

  // DBAs: name lines (may wrap) then "ACTIVE AS OF d" or "ACTIVE FROM d TO d".
  for (const e of take("DBA")) {
    if (NONE.test(e.lines[0])) { e.lines.slice(1).forEach((line) => unparsed.push({ label: "DBA", line })); continue; }
    const si = e.lines.findIndex((l) => /^ACTIVE (AS OF|FROM)\b/i.test(l));
    const status = si >= 0 ? e.lines[si] : "";
    const range = status.match(/^ACTIVE FROM (\S+) TO (\S+)$/i);
    const asOf = status.match(/^ACTIVE AS OF (\S+)$/i);
    const nameLines = si >= 0 ? e.lines.slice(0, si) : e.lines;
    e.lines.slice(si >= 0 ? si + 1 : e.lines.length).forEach((line) => unparsed.push({ label: "DBA", line }));
    push({
      kind: "dba", is_current: !!asOf, related_license_number: null, related_name: nameLines.join(" "),
      from_date: toDate(range?.[1] ?? asOf?.[1]), to_date: toDate(range?.[2]), related_expiration_date: null,
      ended_status: null, ended_on: null, officer_restricted: null, corporation_restricted: null,
      raw_text: [...nameLines, status].filter(Boolean).join(" | "),
    });
  }

  // ---- discipline / public comments and documents ---------------------------
  const actions: Action[] = [];
  for (const line of take("Comment").flatMap((e) => e.lines)) {
    if (NONE.test(line) || END_MARKER.test(line)) continue;
    const m = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(.*)$/);
    const prev = actions.at(-1);
    if (!m && prev?.kind === "comment") { prev.text_verbatim += ` ${line}`; continue; } // wrapped comment
    actions.push({ seq: actions.length + 1, kind: "comment", action_date: toDate(m?.[1]), text_verbatim: m ? m[2] : line, document_url: null });
  }
  for (const e of take("Disciplinary or Formal Action Documents")) {
    for (const l of e.links) {
      actions.push({ seq: actions.length + 1, kind: "document", action_date: null, text_verbatim: l.text, document_url: new URL(l.href, DRE_BASE).toString() });
    }
    e.lines.forEach((line) => {
      if (!END_MARKER.test(line) && !e.links.some((l) => l.text === line)) unparsed.push({ label: "Disciplinary or Formal Action Documents", line });
    });
  }

  // Anything left is a label we don't handle yet: keep it verbatim.
  for (const [label, es] of fields) for (const e of es) for (const line of e.lines) if (!END_MARKER.test(line)) unparsed.push({ label, line });

  return { record, affiliations, actions };
}

export { clean };
