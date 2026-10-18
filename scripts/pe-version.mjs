// Read the version resource out of a Windows PE file (the .exe installer).
//
// Windows shows this in the file's Properties -> Details tab, and it is the
// version the installer and uninstaller identify themselves by, so it is the
// closest thing to "what the installed build reports" without running Windows.
// electron-builder writes it from package.json at package time.

function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const start = section.virtualAddress;
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= start && rva < start + size) return section.rawPointer + (rva - start);
  }
  return -1;
}

function readSections(buffer) {
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error('not a PE file');
  const coff = peOffset + 4;
  const sectionCount = buffer.readUInt16LE(coff + 2);
  const optionalSize = buffer.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unexpected optional header magic 0x${magic.toString(16)}`);
  // Data directories start after the fixed optional header fields.
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const resourceRva = buffer.readUInt32LE(directories + 2 * 8);
  const resourceSize = buffer.readUInt32LE(directories + 2 * 8 + 4);
  const table = optional + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const entry = table + i * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(entry + 8),
      virtualAddress: buffer.readUInt32LE(entry + 12),
      rawSize: buffer.readUInt32LE(entry + 16),
      rawPointer: buffer.readUInt32LE(entry + 20),
    });
  }
  return { sections, resourceRva, resourceSize };
}

// Resource directory entries: { name, offset, isDirectory }.
function readEntries(buffer, base, dirOffset) {
  const dir = base + dirOffset;
  const named = buffer.readUInt16LE(dir + 12);
  const ids = buffer.readUInt16LE(dir + 14);
  const entries = [];
  for (let i = 0; i < named + ids; i++) {
    const entry = dir + 16 + i * 8;
    const name = buffer.readUInt32LE(entry);
    const offset = buffer.readUInt32LE(entry + 4);
    entries.push({ id: name & 0x80000000 ? null : name, offset: offset & 0x7fffffff, isDirectory: Boolean(offset & 0x80000000) });
  }
  return entries;
}

/** @returns {{fileVersion: string, productVersion: string} | null} */
export function readExeVersion(buffer) {
  const { sections, resourceRva, resourceSize } = readSections(buffer);
  if (!resourceRva || !resourceSize) throw new Error('PE file has no resource directory');
  const base = rvaToOffset(sections, resourceRva);
  if (base < 0) throw new Error('resource directory is not mapped by any section');

  // RT_VERSION is resource type 16; take its first name entry, then its first
  // language entry, which is the data block holding VS_VERSIONINFO.
  const type = readEntries(buffer, base, 0).find(entry => entry.id === 16);
  if (!type?.isDirectory) throw new Error('no RT_VERSION resource');
  const named = readEntries(buffer, base, type.offset).find(entry => entry.isDirectory);
  if (!named) throw new Error('RT_VERSION has no data');
  const language = readEntries(buffer, base, named.offset).find(entry => !entry.isDirectory);
  if (!language) throw new Error('RT_VERSION has no language entry');
  const dataEntry = base + language.offset;
  const dataOffset = rvaToOffset(sections, buffer.readUInt32LE(dataEntry));
  const dataSize = buffer.readUInt32LE(dataEntry + 4);
  if (dataOffset < 0) throw new Error('version resource is not mapped by any section');

  // VS_FIXEDFILEINFO starts with the 0xFEEF04BD signature; the four DWORDs after
  // it are file version MS/LS then product version MS/LS.
  const blob = buffer.subarray(dataOffset, dataOffset + dataSize);
  const at = blob.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
  if (at < 0) throw new Error('VS_FIXEDFILEINFO signature was not found');
  const dword = offset => blob.readUInt32LE(at + offset);
  const format = (ms, ls) => [ms >> 16, ms & 0xffff, ls >> 16, ls & 0xffff].join('.');
  return { fileVersion: format(dword(8), dword(12)), productVersion: format(dword(16), dword(20)) };
}
