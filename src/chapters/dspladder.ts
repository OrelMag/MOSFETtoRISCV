// The signal processing level's ladder (no imports but the order): every planned chapter in book order. A chapter shows once it is in the book,
// so a phase adds no row here; tests/dsp-ladder.test.ts holds the rows to the chapters. The first chapter draws it.

import { BOOK_ORDER, numOf, type ChapterId } from './order';

export const DSP_LEVEL = 'Signal processing';

export const DSP_LADDER: readonly { id: string; title: string; asks: string }[] = [
  { id: 'fixed', title: 'Numbers that fit', asks: 'What happens when a sum does not fit?' },
  { id: 'zplane', title: 'The z-plane', asks: 'How can one picture hold a filter?' },
  { id: 'spectrum', title: 'Measuring a spectrum', asks: 'Why does a pure tone show a skirt?' },
  { id: 'firdesign', title: 'FIR design', asks: 'How few taps meet a mask?' },
  { id: 'iir', title: 'IIR and stability', asks: 'What does feedback buy, and what can it break?' },
  { id: 'multirate', title: 'Changing the rate', asks: 'How do you filter at a thousandth of the price?' },
  { id: 'cordic', title: 'Turning by shifting', asks: 'Can you rotate with no multiplier?' },
  { id: 'mac', title: 'A MAC on the RV32', asks: 'What is one instruction worth?' },
  { id: 'dspcore', title: 'A DSP core', asks: 'What does a processor look like when the loop is the point?' },
  { id: 'converters', title: 'Converters', asks: 'How does one bit make 16?' },
  { id: 'adaptive', title: 'Filters that learn', asks: 'How do you cancel an echo you cannot measure?' },
  { id: 'speech', title: 'Speech', asks: 'How does a voice fit in 2.4 kb/s?' },
  { id: 'music', title: 'Music', asks: 'What can a codec safely throw away?' },
  { id: 'sensors', title: 'Image sensors', asks: 'Where does a picture come from?' },
  { id: 'pictures', title: 'Pictures', asks: 'Why does a JPEG look blocky?' },
  { id: 'sdr', title: 'A software radio', asks: 'Can you receive a station with what you have built?' },
];

const inBook = (id: string): id is ChapterId => (BOOK_ORDER as readonly string[]).includes(id);

/** The rows built so far, with their numbers. */
export const dspRows = (): { id: string; num: number; title: string; asks: string }[] =>
  DSP_LADDER.filter((r) => inBook(r.id)).map((r) => ({ ...r, num: numOf(r.id as ChapterId) }));
