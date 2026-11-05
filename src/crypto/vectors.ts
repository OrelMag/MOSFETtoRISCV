// The NIST vectors the chapter's scenes load. They are the standards' own values; tests/crypto-aes.test.ts and crypto-sha256.test.ts hold them
// equal to the fixtures read out of the PDFs (scripts/crypto-vectors.mjs), so a typo here cannot survive.
import { fromHex } from './aes';

/** FIPS 197 Appendix B, the cipher example. */
export const APPENDIX_B = {
  input: fromHex('3243f6a8885a308d313198a2e0370734'),
  key: fromHex('2b7e151628aed2a6abf7158809cf4f3c'),
};
/** The NIST example document's one-block message. */
export const SHA_ABC = 'abc';
/** The two-block message of the same document (FIPS 180-4 Appendix B.2). */
export const SHA_TWO_BLOCK = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
