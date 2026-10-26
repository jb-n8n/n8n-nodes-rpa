import { quickEnvelope, stepBinary } from '../../output.js';
import { choice, outputProperty, type QuickCompiler, type QuickOutput } from './shared.js';

const PAPERS = ['A4', 'Letter'] as const;
export const PAPER_INVALID = 'Paper must be A4 or Letter';

/** Save as PDF: Paper A4 (default) / Letter, Options → Print Background. Needs headless Chromium (engine). */
export const compilePdf: QuickCompiler = (params) => {
  const paper = choice(params.paper, PAPERS, 'A4', PAPER_INVALID);
  outputProperty(params.options, 'pdfProperty', 'pdf'); // a bad Put Output in Field fails before the run
  return {
    script: { steps: [{ intent: 'Save the page as PDF', pdf: { paper, background: params.options.printBackground === true } }] },
    vars: {},
  };
};

/** The envelope plus the PDF under Options → Put Output in Field (default "pdf"). */
export const pdfOutput: QuickOutput = async (ctx, run) => [
  {
    json: quickEnvelope(run.result, run.compiled),
    binary: await stepBinary(ctx, run.result, 'pdf', outputProperty(run.params.options, 'pdfProperty', 'pdf')),
  },
];
