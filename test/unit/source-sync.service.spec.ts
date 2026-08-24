import { sourceValue } from '../../server/modules/approval/source-sync.service';

describe('SourceSyncService value mapping', () => {
  it('keeps amount values as strings to avoid floating point conversion', () => {
    expect(sourceValue('1000000000000.01', 'amount')).toBe('1000000000000.01');
  });

  it('keeps computed formula values as strings to avoid floating point conversion', () => {
    expect(sourceValue('0.07', 'formula')).toBe('0.07');
  });

  it('converts approval dates to Base timestamps', () => {
    expect(sourceValue('2026-08-11 10:30:00', 'date')).toBe(
      Date.parse('2026-08-11 10:30:00'),
    );
  });

  it('does not convert attachment values synchronously', () => {
    expect(sourceValue([{ url: 'https://example.com/redacted' }], 'attachmentV2')).toStrictEqual(
      [{ url: 'https://example.com/redacted' }],
    );
  });
});
