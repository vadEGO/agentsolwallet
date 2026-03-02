export const migration006 = `
ALTER TABLE snapshot_entries ADD COLUMN metadata TEXT;
`;
