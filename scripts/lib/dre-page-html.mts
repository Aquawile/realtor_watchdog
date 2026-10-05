// Reads a raw DRE Public License Lookup page into labeled fields.
//
// Page layout (all pages share it): a <table> of rows, each
//   <td>Label:</td><td>value lines separated by <br/></td>
// A row with an empty label continues the previous label. Inside a value
// cell, a blank line (<br/><br/>) separates entries (e.g. several former
// brokers). Labels can themselves be split by <br/> ("Disciplinary or Formal
// Action<br/>Documents"). The markup is 2000s-era and broken (unclosed <font>),
// so it is parsed with an HTML5 parser (cheerio/parse5), never with regexes.

import * as cheerio from "cheerio";

export type Link = { text: string; href: string };
export type Entry = { lines: string[]; links: Link[] };
export type PageFields = {
  encoding: "utf-8" | "windows-1252";
  lineEndings: "CRLF" | "LF";
  complete: boolean;           // DRE's end-of-record marker present
  notFound: boolean;           // DRE's "No matching public record" page
  recordsAsOf: string | null;  // "9/27/2026 1:40:26 PM" (DRE's timestamp, Pacific)
  fields: Map<string, Entry[]>;
};

// Collapse all whitespace, including &nbsp; (U+00A0).
export const clean = (s: string) => s.replace(/[\s ]+/g, " ").trim();

export function decode(bytes: Uint8Array): { text: string; encoding: PageFields["encoding"] } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

export function readPage(bytes: Uint8Array): PageFields {
  const { text: rawText, encoding } = decode(bytes);
  const lineEndings = rawText.includes("\r\n") ? "CRLF" : "LF";
  const text = rawText.replace(/\r\n?/g, "\n");
  const $ = cheerio.load(text);

  const fields = new Map<string, Entry[]>();
  let label = "";
  $("table tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length !== 2) return;
    $(tds[0]).find("br").replaceWith(" ");
    const l = clean($(tds[0]).text()).replace(/\s*:$/, "");
    if (l) label = l;
    if (!label) return;
    const segments = ($(tds[1]).html() ?? "").split(/<br\s*\/?>/i);
    let cur: Entry = { lines: [], links: [] };
    const flush = () => {
      if (!cur.lines.length) return;
      if (!fields.has(label)) fields.set(label, []);
      fields.get(label)!.push(cur);
      cur = { lines: [], links: [] };
    };
    for (const seg of segments) {
      const $seg = cheerio.load(`<div>${seg}</div>`);
      const line = clean($seg("div").text());
      // DRE's end-of-record marker sits in an unlabeled row: it's not data.
      if (!line || /Public information request complete/i.test(line)) { flush(); continue; }
      cur.lines.push(line);
      $seg("a").each((_, a) => { cur.links.push({ text: clean($seg(a).text()), href: $seg(a).attr("href") ?? "" }); });
    }
    flush();
  });

  return {
    encoding, lineEndings, fields,
    complete: /Public information request complete/i.test(text),
    notFound: /No matching public record was found/i.test(text),
    recordsAsOf: text.match(/taken from records of the Department of Real Estate on\s+([\d/]+\s+[\d:]+\s+[AP]M)/)?.[1] ?? null,
  };
}
