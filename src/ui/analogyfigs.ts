// Figures inside Analogy asides (chapters/analogies.ts `figure`), each its own chunk, loaded when its aside first opens.
// A figure draws into `host` and stops its own animation once `host` leaves the document (host.isConnected): the
// chapter page replaces the body on every step without telling the asides.

export type FigureMount = (host: HTMLElement) => void;

export const FIGURES: Record<string, () => Promise<FigureMount>> = {
  'water-cmos': async () => (await import('../widgets/waterscenes')).cmosFigure(false),
  'water-cmos-weak': async () => (await import('../widgets/waterscenes')).cmosFigure(true),
};
