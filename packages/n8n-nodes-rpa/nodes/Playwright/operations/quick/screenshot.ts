import type { Step } from 'n8n-rpa-engine';
import { quickEnvelope, stepBinary } from '../../output.js';
import { choice, locatorValue, outputProperty, toLocator, type QuickCompiler, type QuickOutput } from './shared.js';

const CAPTURES = ['fullPage', 'viewport', 'element'] as const;
export const CAPTURE_INVALID = 'Capture must be Full Page, Viewport or One Element';

/** Screenshot: Capture Full Page (default) / Viewport / One Element (+ Element locator). */
export const compileScreenshot: QuickCompiler = (params) => {
  const capture = choice(params.capture, CAPTURES, 'fullPage', CAPTURE_INVALID);
  outputProperty(params.options, 'screenshotProperty', 'screenshot'); // a bad Put Output in Field fails before the run
  const step: Step =
    capture === 'element'
      ? { intent: 'Take a screenshot', screenshot: { capture: 'element', element: toLocator(locatorValue(params.element), 'Element') } }
      : { intent: 'Take a screenshot', screenshot: { capture: capture === 'fullPage' ? 'full' : 'viewport' } };
  return { script: { steps: [step] }, vars: {} };
};

/** The envelope plus the PNG, renamed from screenshot_<i> to Options → Put Output in Field (default "screenshot"). */
export const screenshotOutput: QuickOutput = async (ctx, run) => [
  {
    json: quickEnvelope(run.result, run.compiled),
    binary: await stepBinary(ctx, run.result, 'screenshot', outputProperty(run.params.options, 'screenshotProperty', 'screenshot')),
  },
];
