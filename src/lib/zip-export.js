// Copyright (C) 2026 HidayahTech, LLC
// Exports a finished ZIP as a single browser download: one object URL, one transient
// same-origin anchor click. Not the iframe handoff path — that exists to contain
// cross-origin error responses; a same-origin OPFS blob needs no containment.
//
// `doc` and `urlImpl` are injectable so this stays testable in plain Node.

export async function exportZip(getFileFn, zipName, doc = document, urlImpl = URL) {
  const f = await getFileFn();
  const url = urlImpl.createObjectURL(f);
  const a = doc.createElement('a');
  a.href = url;
  a.download = zipName;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  // Revoking synchronously races the download start; defer well past it.
  setTimeout(() => urlImpl.revokeObjectURL(url), 10_000);
}
