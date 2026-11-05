// Pictures (level Signal processing): why does a JPEG look blocky? 2-D filtering and resizing on generated pictures, the 8 × 8 DCT (an 8-point stage in gates, lib/dct.ts,
// compared with dsp/pictures.ts every vector), quantization with T.81's Annex K table, zig-zag and Huffman, and a real baseline file that libjpeg (through Pillow) and the browser decode.

import { encodeJpeg, filterCost, grow, psnr, scene, shrink, zonePlate } from '../dsp/pictures';
import { dctStage } from '../lib/dct';
import { register } from '../lib/sequential';
import { stats } from '../sim/stats';
import { dctApi, dctScene, dctWidget, fileApi, fileWidget, filterWidget, huffWidget, pictureWidget, qualityWidget, resizeWidget } from '../widgets/dsppictures';
import { numOf } from './order';
import type { Chapter } from './types';

const n0 = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
let memo: ReturnType<typeof encodeJpeg>[] | undefined;
/** The scene at the qualities the prose names. */
const at = () => (memo ??= [10, 50, 90].map((q) => encodeJpeg(scene(), q)));

export const chPictures: Chapter = {
  id: 'pictures', num: numOf('pictures'), title: 'Pictures', level: 'Signal processing',
  blurb: 'Why does a JPEG look blocky? Filters and resizing in two dimensions, the 8 × 8 DCT with a stage in gates, quantization, zig-zag and Huffman, and a real file your browser opens.',
  goals: [
    'filter and resize a picture as a 2-D signal, and say what separability saves',
    'say what the 8 × 8 DCT does to a block, and what one stage of it costs in gates',
    'show where JPEG loses information, and where it only rearranges it',
    'write a baseline JPEG file that two outside decoders open',
  ],
  builds: ['signals', 'multirate', 'fixed'],
  recap: {
    keep: [
      'A picture is a 2-D signal. Sampling, folding and filtering work along each axis as they did along time, and a kernel that is a product of two 1-D filters costs 2n multiplications a sample, not n².',
      'Shrinking keeps one sample in m, so anything above 1/(2m) cycles a sample folds into false patterns unless a low-pass removes it first.',
      'The 8 × 8 DCT loses nothing. It moves a block\'s energy into a few low-frequency coefficients, and it is two passes of an 8-point transform, rows then columns.',
      'Quantization is JPEG\'s only loss: each coefficient divided by its table entry and rounded. The quality setting only scales T.81\'s example table.',
      'Zig-zag order puts the zeros in long runs, and Huffman codes the (run, size) pairs, with the magnitudes as plain extra bits behind them.',
    ],
    check: [
      {
        question: 'A blur kernel is 15 × 15 and is a product of a row filter and a column filter. How many multiplications a sample does it need, done the cheap way?',
        options: ['30', '225', '15', '450'],
        answer: 0,
        explain: 'A row pass of 15 and a column pass of 15. The full kernel would be 225.',
        why: ['', 'That is the kernel applied whole.', 'That is only one of the two passes.', 'That counts both passes as if each were whole.'],
      },
      {
        question: 'Where in a JPEG encoder is information thrown away?',
        options: ['In rounding each coefficient over its table entry', 'In the DCT itself', 'In the Huffman coding', 'In the zig-zag reordering of the block'],
        answer: 0,
        explain: 'The transform can be undone to rounding, and zig-zag and Huffman are exact. Only quantization loses.',
        why: ['', 'Its inverse gives the block back, to the last bit of a float.', 'A Huffman code decodes to exactly what went in.', 'A reordering only changes which coefficient is sent first.'],
      },
      {
        question: 'Why does JPEG scan the coefficients in zig-zag order?',
        options: ['It puts the zeros together at the end', 'It makes the DCT cheaper to compute', 'It improves the PSNR', 'The Huffman table requires a sorted list'],
        answer: 0,
        explain: 'High frequencies are usually quantized to 0, and zig-zag goes from low to high, so the zeros come in long runs that a few codes, and one end of block, cover.',
        why: ['', 'The order is chosen after the transform, and costs it nothing.', 'It changes nothing about what is lost.', 'The codes are for (run, size) pairs, in any order.'],
      },
    ],
  },
  steps: [
    {
      title: 'A picture is a signal',
      get body() {
        const p = scene();
        return `
        <p>Sound was one row of samples in time. A grey picture is samples on a grid: ${p.w} across, ${p.h} down, each a level from 0 to 255. At 8 bits a sample that is ${n0(p.w * p.h)} bytes, before anything is done to it. Colour would be three such grids.</p>
        <p>Everything learned about samples still holds, one axis at a time. A row is a signal along x, a column along y, and a picture has a spectrum in two dimensions: smooth sky is low frequency, a sharp edge or fine stripes are high. <a href="#/c/signals/5">Sampling folds</a> anything above half the rate, along either axis.</p>
        <p>The pictures in this chapter are generated, so every number is the same everywhere: a sky, a sun, a mountain, stripes, rings and a little noise. The last step takes a picture of your own, read in your browser and never sent anywhere.</p>
        <div class="try">Move the row down from the sky into the stripes, and watch the plot go from a gentle slope to a square wave.</div>`;
      },
      widget: pictureWidget,
      challenge: {
        kind: 'quiz', question: 'A row crosses the striped area. What does its plot look like?',
        options: ['A square wave, high and low in turn', 'A gentle ramp', 'A flat line', 'Noise with no pattern'],
        answer: 0,
        explain: 'Stripes three samples wide, light and dark in turn: along a row that is a square wave, a signal full of high frequencies.',
        why: ['', 'That is the sky, which changes slowly from top to bottom.', 'Only an even area is flat.', 'The noise is small, and the stripes are far larger.'],
      },
    },
    {
      title: 'Filters in two dimensions',
      body: `
        <p>A filter on a picture is <a href="#/c/signals/3">a sum of neighbouring samples</a>, as it was in time, with weights laid out on a small grid: the <strong>kernel</strong>. Slide it across, and each output is the weighted sum of the samples under it. At the picture's edge something has to stand in for the samples outside it. Here it is the nearest edge sample, which scipy calls mode "nearest", and the tests hold every kernel equal to scipy's to 9 places.</p>
        <p>Averaging blurs: it is a low-pass. A kernel that adds a sample's difference from its neighbours sharpens: a high-pass added back. A slope across, smoothed down, finds vertical edges.</p>
        <p>The price is the kernel's size. A 3 × 3 kernel is ${filterCost(3).full} multiplications a sample, and a 15 × 15 blur ${filterCost(15).full}. But many useful kernels are a row filter times a column filter, and then two passes do the same job: ${filterCost(3).separable} and ${filterCost(15).separable}. The tests check that the binomial blur done both ways agrees to rounding. This is called a <strong>separable</strong> kernel, and the DCT below is separable too.</p>
        <div class="try">Try each kernel on the scene, then on the zone plate, whose rings get finer towards the corners. The blur rubs out the fine ones first.</div>`,
      widget: filterWidget,
      challenge: {
        kind: 'quiz', question: 'Which of these kernels can be done as a row pass and then a column pass?',
        options: ['The binomial blur', 'Any 3 × 3 kernel at all', 'The sharpening kernel', 'None of them, in two dimensions'],
        answer: 0,
        explain: '[1 2 1] across times [1 2 1] down gives exactly the blur. The sharpening kernel is a plus shape, and no row times column makes it.',
        why: ['', 'Only a kernel whose rows are all multiples of one row is separable.', 'Its plus shape is not a product of a row and a column.', 'The blur is one, and the tests check it.'],
      },
    },
    {
      title: 'Smaller and larger',
      get body() {
        const z = zonePlate(), raw = shrink(z, 3, false), f = shrink(z, 3, true);
        return `
        <p>Shrinking a picture three times keeps one sample in three along each axis, and <a href="#/c/multirate/1">the rate chapter</a> said what that does: anything above a sixth of a cycle a sample folds down and shows as a pattern that was never there. The zone plate makes it plain. Its rings reach half a cycle a sample at the edge, and kept one in three they come back as false rings around other centres.</p>
        <p>The cure is the same as for sound: a low-pass first, here a windowed sinc cut at 1/(2m) of the rate, done as a row pass and a column pass. The fine rings are then simply gone, which is the right answer, as no small picture can hold them. Kept one in three, the plate has ${raw.w} × ${raw.h} samples whichever way it is done.</p>
        <p>Growing a picture back has the opposite problem. Repeating each sample makes blocks. Drawing straight lines between neighbours, bilinear, is smoother, and still cannot bring back detail the small picture lost. Grown back by repeating samples, the unfiltered version measures ${psnr(z, grow(raw, 3, 'nearest')).toFixed(1)} dB against the original and the filtered one ${psnr(z, grow(f, 3, 'nearest')).toFixed(1)}: the number is close, and the false rings are what the eye notices.</p>
        <div class="try">Keep 1 in 2, then 3, then 4, with and without the low-pass. Then grow back with straight lines and compare the edges.</div>`;
      },
      widget: resizeWidget,
      challenge: {
        kind: 'quiz', question: 'A picture is shrunk to a quarter of its width with no filter first. What appears?',
        options: ['False patterns from detail that folds', 'Nothing: it only gets smaller', 'A uniform blur everywhere', 'Blocks eight samples wide'],
        answer: 0,
        explain: 'Detail above an eighth of a cycle a sample cannot be held after keeping one sample in four, and it does not vanish: it folds to a lower frequency and draws itself there.',
        why: ['', 'It is the folding that a small picture cannot avoid without a low-pass.', 'Blur is what the low-pass gives, and here there is none.', 'Those come from JPEG\'s blocks, not from resizing.'],
      },
    },
    {
      title: 'Cosines in 8 × 8',
      body: `
        <p>JPEG cuts the picture into 8 × 8 blocks and writes each one as a sum of 64 fixed patterns, cosines across times cosines down. The amounts are the block's <strong>DCT</strong> (the discrete cosine transform). T.81 defines it in A.3.3:</p>
        <pre>S(v, u) = ¼ C(u) C(v) Σx Σy s(y, x) cos((2x + 1)uπ/16) cos((2y + 1)vπ/16)      C(0) = 1/√2, else 1</pre>
        <p>The samples are shifted down by 128 first, so a mid-grey block is all zeros. S(0, 0) is then eight times the block's mean, and the rest are how much of each pattern it holds. The tests hold this equal to scipy's orthonormal DCT on both axes, to 9 places, and its inverse gives the block back to 13: nothing is lost here.</p>
        <p>What the transform does is move energy. A smooth block has nearly all of its energy in a handful of low-frequency coefficients, and the rest are close to zero. A block of fine detail spreads wider. It is separable, so it can be done as an 8-point transform on each row and then on each column.</p>
        <div class="try">Pick the sky, then the sun's edge, then the checks. Count how many coefficients the sky really needs.</div>`,
      widget: dctWidget,
      challenge: {
        kind: 'quiz', question: 'What does the DCT of a smooth block look like?',
        options: ['A few large coefficients, low and top left', 'Every coefficient about the same size', 'All 64 coefficients exactly zero', 'One large coefficient at the bottom right'],
        answer: 0,
        explain: 'Smooth means slowly changing, so the low-frequency patterns are enough. Those sit at the top left: u and v both small.',
        why: ['', 'That is how a noisy block looks.', 'Only a block of exactly mid-grey is all zeros.', 'The bottom right is the finest pattern, and a smooth block has least of it.'],
      },
    },
    {
      title: 'The DCT in gates',
      get body() {
        const s = nands(dctStage()), reg = nands(register(12));
        return `
        <p>An 8-point DCT is 64 multiplications done directly. The cosines have symmetries that cut that down. Add and subtract each sample and its mirror, x<sub>i</sub> ± x<sub>7−i</sub>, and the even outputs only need the sums and the odd outputs only the differences. Split the even half once more, and what is left is 22 products by constants: 2 for X0 and X4, 4 for X2 and X6, and 16 for the four odd outputs.</p>
        <p>A product by a constant needs no multiplier. Each constant is written in signed digits, and each digit is the input moved by wiring and added or subtracted, so 1 703 is four adders and 784 is two. Every bit is kept, each output is rounded once at the end, and two extra fraction bits ride along so the second pass starts from better than whole numbers. The stage is ${n0(s)} NANDs. The tests compare it with an integer model on every basis vector, the extremes and thousands of random rows, and every constant multiplier on every input it can take.</p>
        <p>A whole 8 × 8 block is the stage sixteen times: eight rows, then eight columns. Sixteen stages side by side would be about ${n0(16 * s)} NANDs. One stage used sixteen times needs a store to turn rows into columns: 64 words of 12 bits, about ${n0(64 * reg)} NANDs as plain registers, and a counter to run it. The panel here does that turning itself, and says so. On this block the result is within half a level of the true DCT.</p>
        <div class="try">Run a block. Every pass is checked against the model, and the panel shows the coefficients beside how far they are from the exact ones.</div>`;
      },
      scene: dctScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run a block through the stage, sixteen passes, every one agreeing with the model.',
        check: (st) => !!dctApi.get(st)?.agrees(),
        hints: ['The panel beside the circuit has one button.'],
        answer: 'Eight passes along the rows, then eight down the columns, each through the same gates. The integer model gives the same numbers at every pass, and the result is within half a level of the exact transform.',
        solve: (st) => { dctApi.get(st)?.run(); },
      },
    },
    {
      title: 'Quantization is the only loss',
      get body() {
        const [lo, mid, hi] = at(), p = scene();
        return `
        <p>Here the loss happens, at one step. Each coefficient is divided by an entry of a table and rounded to the nearest whole number. Large divisors at high frequencies send most of those coefficients to zero, and the eye forgives that more readily than errors in the smooth parts. The table is T.81's Table K.1, which the standard gives as an example "used with good results", not a requirement.</p>
        <p>The quality setting is not in T.81 at all. It is libjpeg's: below 50 the table is scaled by 5000 / q percent, above it by 200 − 2q, each entry rounded and kept between 1 and 255. At quality 50 that is K.1 itself. The tests hold this against the tables Pillow's libjpeg writes, at nine qualities from 1 to 100.</p>
        <p>On this scene, quality 10 makes ${n0(lo.bytes.length)} bytes at ${psnr(p, lo.out).toFixed(1)} dB, quality 50 ${n0(mid.bytes.length)} bytes at ${psnr(p, mid.out).toFixed(1)} dB, and quality 90 ${n0(hi.bytes.length)} bytes at ${psnr(p, hi.out).toFixed(1)} dB, against ${n0(p.w * p.h)} raw. Those are real file sizes, headers included. At low quality the eight-sample grid shows, first in smooth areas such as the sky, because each block keeps little more than its own mean and the next one's mean is not the same.</p>
        <div class="try">Take quality down to 10 and look at the sky and the stripes, then at the error. Then find the quality where you stop seeing the blocks.</div>`;
      },
      widget: qualityWidget,
      challenge: {
        kind: 'quiz', question: 'Why are JPEG\'s blocks most visible in smooth areas at low quality?',
        options: ['Each block keeps little more than its mean', 'Smooth areas have more high frequencies', 'The DCT is less exact there', 'Huffman codes them with fewer bits'],
        answer: 0,
        explain: 'With most coefficients rounded away, a block becomes nearly flat at its own mean. Neighbouring blocks have slightly different means, so the grid shows as steps where the original had a smooth slope.',
        why: ['', 'They have fewer, and that is why so little is kept.', 'The transform is exact to rounding everywhere.', 'The coding is exact; what is lost was lost in quantizing.'],
      },
    },
    {
      title: 'Zig-zag, runs and codes',
      get body() {
        const r = at()[1], t = r.bits;
        return `
        <p>What is left is mostly zeros, and the file is arranged so that they cost almost nothing. The 63 coefficients after S(0, 0) are read in <strong>zig-zag</strong> order, T.81's Figure A.6, along the diagonals from low frequency to high, so the zeros at the far end come in one long run.</p>
        <p>S(0, 0) is sent as its difference from the last block's, since neighbouring means are close. Every other non-zero coefficient becomes a pair: how many zeros came before it, and its size category, the bits its magnitude needs. A Huffman code is sent for the pair, then the magnitude itself in that many plain bits. Sixteen zeros in a row have a code of their own, ZRL, and one code, EOB, says the rest of the block is zero.</p>
        <p>The codes come from T.81's Tables K.3 and K.5, again "typical" tables, which a file carries as two short lists: how many codes of each length, and the symbols in order. The codes follow from those lists, so a decoder rebuilds them and every code here matches the code words the standard prints. In the file at quality 50 the Huffman codes take ${n0((t.dcCodes + t.acCodes) / 8)} bytes, the plain extra bits ${n0((t.dcExtra + t.acExtra) / 8)}, and the markers and tables ${n0(t.header / 8)}. One more rule: a byte of 0xFF in the coded data is followed by a 0, so that it is never taken for a marker.</p>
        <div class="try">Pick a block and read its symbols. Then compare the sky with the checks: the sky ends with EOB almost at once.</div>`;
      },
      widget: huffWidget,
      challenge: {
        kind: 'quiz', question: 'A block\'s last non-zero coefficient is at zig-zag position 5. What ends the block?',
        options: ['One EOB code', 'Fifty-eight codes for zero', 'Three ZRL codes and a 0', 'Nothing: blocks are a fixed length'],
        answer: 0,
        explain: 'EOB says everything after this is zero, in four bits with K.5\'s table.',
        why: ['', 'Zeros are never sent one at a time: they are counted into the next pair.', 'ZRL is only for a run of zeros followed by something that is not zero.', 'A block is 64 coefficients, but the file only sends up to the last one that is not zero.'],
      },
    },
    {
      title: 'A file another program opens',
      get body() {
        const r = at()[1];
        return `
        <p>Put it together, and it is a file. A baseline JPEG is a list of segments, each a marker and a length: start of image, a JFIF header, the quantization table in zig-zag order, the frame (8-bit samples, the size, one component), the two Huffman tables, the start of scan, the coded data, and end of image. For this scene at quality 50 it is ${n0(r.bytes.length)} bytes.</p>
        <p>This page wrote every one of those bytes, and two programs that had no part in it read them. The tests decode this chapter's files with libjpeg through Pillow and find every pixel within one level of our own reconstruction. Here your browser decodes the same bytes. A level or so either way is expected: T.81 sets how exact an inverse DCT must be, not one way of computing it, and fast decoders use integer ones.</p>
        <p>Try a picture of your own. It is read and turned grey by your browser, and goes nowhere.</p>
        <div class="try">Lower the quality until you can see the blocks in the browser's own decode. Then save the file and open it in another program.</div>`;
      },
      widget: fileWidget,
      challenge: {
        kind: 'reach', goal: 'Have the browser decode a file from this page within a level of our reconstruction.',
        check: () => fileApi.decoded && fileApi.maxDiff >= 0 && fileApi.maxDiff <= 1,
        hints: ['The widget does it as it loads. If the chip shows no difference, it is already done.'],
        answer: 'The browser decodes the bytes with its own decoder, and the canvas read back from it differs from our reconstruction by at most a level.',
      },
    },
  ],
};

