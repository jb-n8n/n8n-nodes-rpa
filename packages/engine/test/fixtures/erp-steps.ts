// The ERP Demo sample project (test/fixtures/import/uipath-erp-desktop) as the desktop steps the UiPath importer makes of
// it, and the run variables its steps take. Shared by the import test and the fake runner's ERP Demo v2 test.
import type { DesktopScript, DesktopStep } from '../../src/types.js';
import { ERP_PASSWORD, ERP_USER } from '../fake-runner.js';

const W_LOGIN = { exe: 'erpdemo.exe', title: 'ERP Demo - Sign in' };
const W_MAIN = { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' };
const W_SAVE = { exe: 'erpdemo.exe', title: 'Export line items', className: '#32770' };
/** A locator with the automation-id fallback the importer adds when the primary names more than id and type. */
const withFallback = (window: object, cond: Record<string, string>) => ({
  uia: { window, path: [cond] },
  fallbacks: [{ uia: { window, path: [{ controlType: cond.controlType, automationId: cond.automationId }] } }],
});

/** The sample project as desktop steps: exactly what the importer must produce. */
export const EXPECTED: DesktopScript = {
  surface: 'desktop', name: 'erp-1', version: 1, app: { exe: 'ErpDemo.exe' },
  steps: [
    { intent: 'Wait for the window ERP Demo - Sign in', waitFor: { target: { uia: { window: W_LOGIN, path: [{ controlType: 'Edit', automationId: 'txtUser', name: 'User name' }] } } } },
    { intent: 'Type into User name', fill: { field: withFallback(W_LOGIN, { controlType: 'Edit', automationId: 'txtUser', name: 'User name' }), value: '{{var.username}}' } },
    { intent: 'Type into Password', fill: { field: withFallback(W_LOGIN, { controlType: 'Edit', automationId: 'txtPassword', name: 'Password' }), value: '{{var.password}}' } },
    { intent: 'Press Enter in Password', key: { key: 'Enter', target: withFallback(W_LOGIN, { controlType: 'Edit', automationId: 'txtPassword', name: 'Password' }) } },
    { intent: 'Wait for the window ERP Demo - Line items', waitFor: { target: { uia: { window: W_MAIN, path: [{ controlType: 'ComboBox', automationId: 'cmbCompany', name: 'Company code' }] } } } },
    { intent: 'Choose {{var.in_CompanyCode}} in Company code', select: { field: withFallback(W_MAIN, { controlType: 'ComboBox', automationId: 'cmbCompany', name: 'Company code' }), option: '{{var.in_CompanyCode}}' } },
    { intent: 'Type into Date from', fill: { field: withFallback(W_MAIN, { controlType: 'Edit', automationId: 'txtDateFrom', name: 'Date from' }), value: '{{var.in_DateFrom}}' } },
    { intent: 'Type into Date to', fill: { field: withFallback(W_MAIN, { controlType: 'Edit', automationId: 'txtDateTo', name: 'Date to' }), value: '{{var.in_DateTo}}' } },
    { intent: 'Click Search', click: withFallback(W_MAIN, { controlType: 'Button', automationId: 'btnSearch', name: 'Search' }) },
    { intent: 'Read Result count as out_ResultCount', read: { target: { uia: { window: W_MAIN, path: [{ controlType: 'Text', automationId: 'lblResultCount' }] } }, as: 'out_ResultCount' } },
    { intent: 'Read First document as out_FirstDocument', read: { target: { uia: { window: W_MAIN, path: [{ automationId: 'gridResults' }, { controlType: 'DataItem', name: 'Document Row 0' }] } }, as: 'out_FirstDocument' } },
    { intent: 'Click File', click: { uia: { window: W_MAIN, path: [{ controlType: 'MenuItem', name: 'File' }] } } },
    // The drop-down is an untitled window of the app: the class had a wildcard, so only the app names it.
    { intent: 'Click Export...', click: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ controlType: 'MenuItem', name: 'Export...' }] } } },
    { intent: 'Wait for the window Export line items', waitFor: { target: { uia: { window: W_SAVE, path: [{ controlType: 'Edit', automationId: '1001', name: 'File name:', className: 'Edit' }] } } } },
    { intent: 'Type into File name:', fill: { field: withFallback(W_SAVE, { controlType: 'Edit', automationId: '1001', name: 'File name:', className: 'Edit' }), value: '{{$exportDir}}\\line-items.csv' } },
    { intent: 'Click Save', click: withFallback(W_SAVE, { controlType: 'Button', automationId: '1', name: 'Save', className: 'Button' }) },
    { intent: 'Return the exported file line-items.csv', expectFile: { pattern: '^line-items\\.csv$' } },
  ] as DesktopStep[],
};
export const VARS = { username: ERP_USER, password: ERP_PASSWORD, in_CompanyCode: '1000', in_DateFrom: '2026-01-01', in_DateTo: '2026-12-31' };
