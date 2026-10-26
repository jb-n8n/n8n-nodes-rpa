// The realistic Fiori app: a launchpad-style shell with a sap.m.GenericTile, and a list report built
// with real OpenUI5 1.148.10 controls from an XML view, reading LineItems through ODataModel V2 (odata.js) and exporting XLSX.
// UI5 itself comes from /sap/public/bc/ui5_ui5/resources/ (ui5-proxy.js). The real launchpad (sap.ushell) is not part of
// OpenUI5, so the shell is a plain page. Realistic mode only (server.js), behind the SAP logon. No dependencies.
import { crc32, zipStored, xlsxBytes, XLSX_MIME } from './xlsx.js';
import { LINE_ITEM_HEADER } from './erp.js';
import { SERVICE_ROOT } from './odata.js';

export const FIORI_PATH = '/sap/bc/ui2/flp';
const UI5_CORE = '/sap/public/bc/ui5_ui5/resources/sap-ui-core.js';
const VIEW_ID = 'application-LineItem-manage-component---worklist';

// The same variant wording as the light look-alike (fiori.js), so a seeded release reads the same in both modes.
const LABELS = {
  baseline: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
  renamed: { tile: 'G/L Line Items', go: 'Apply', xls: 'Download spreadsheet' },
  menu: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
  dialog: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
};
const LAYOUT_ROWS = [['Column', 'Width', 'Visible'], ['Document', '12', 'Yes'], ['Posting Date', '12', 'Yes'], ['Company Code', '8', 'Yes'], ['Amount', '14', 'Yes'], ['Currency', '8', 'No']];

// xlsx.js's writer, shipped to the browser as source (the way fiori.js ships erp.js): the classic GUI's export and this app's
// export are built by the same functions. They call each other by name, so all three are shipped under their own names.
const XLSX_SOURCE = `window.rpaXlsx = (function () {
  var crc32 = ${crc32.toString()};
  var zipStored = ${zipStored.toString()};
  var xlsxBytes = ${xlsxBytes.toString()};
  return { xlsxBytes: xlsxBytes, mime: ${JSON.stringify(XLSX_MIME)} };
})();`;

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// JSON that is safe inside an inline <script>.
const scriptJson = (v) => JSON.stringify(v).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function viewXml(variant, decoy, L) {
  const overflow = variant === 'menu' ? '<layoutData><OverflowToolbarLayoutData priority="AlwaysOverflow"/></layoutData>' : '';
  const columns = LINE_ITEM_HEADER.split(',').map((h) => `<Column><Text text="${xml(h)}"/></Column>`).join('');
  return `<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m" xmlns:f="sap.f" displayBlock="true" height="100%">
<f:DynamicPage id="page" toggleHeaderOnTitleClick="false">
<f:title><f:DynamicPageTitle><f:heading><Title id="title" text="${xml(L.tile)}" level="H2"/></f:heading></f:DynamicPageTitle></f:title>
<f:header><f:DynamicPageHeader pinnable="false"><HBox wrap="Wrap" alignItems="End">
<VBox class="sapUiMediumMarginEnd sapUiSmallMarginBottom"><Label text="Company Code" labelFor="companyCode" required="true"/><Input id="companyCode" width="12rem" maxLength="4"/></VBox>
<VBox class="sapUiMediumMarginEnd sapUiSmallMarginBottom"><Label text="Posting Date" labelFor="postingDate" required="true"/><DateRangeSelection id="postingDate" width="20rem"/></VBox>
<Button id="go" text="${xml(L.go)}" type="Emphasized" class="sapUiSmallMarginBottom"/>
</HBox></f:DynamicPageHeader></f:header>
<f:content><Table id="table" growing="true" growingThreshold="20" noDataText="No data found. Try adjusting the filter settings.">
<headerToolbar><OverflowToolbar id="toolbar"><Title id="tableTitle" text="Line Items" level="H2"/><ToolbarSpacer/>
<OverflowToolbarButton id="export" icon="sap-icon://excel-attachment" text="${xml(L.xls)}" tooltip="${xml(L.xls)}">${overflow}</OverflowToolbarButton>
${decoy ? '<OverflowToolbarButton id="exportLayout" icon="sap-icon://action-settings" text="Export layout" tooltip="Export layout"/>' : ''}
</OverflowToolbar></headerToolbar>
<columns>${columns}</columns>
</Table></f:content>
</f:DynamicPage>
</mvc:View>`;
}

function page(st) {
  const variant = LABELS[st.erp] ? st.erp : 'baseline';
  const L = LABELS[variant];
  const cfg = { variant, L, viewId: VIEW_ID, view: viewXml(variant, !!st.erpDecoy, L), service: `${SERVICE_ROOT}/`, layout: LAYOUT_ROWS, header: LINE_ITEM_HEADER.split(',') };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Home</title>
<style>html,body{height:100%;margin:0}#shell{position:absolute;top:0;left:0;right:0}#content{position:absolute;top:3.25rem;bottom:0;left:0;right:0}</style>
<script id="rpa-xlsx">${XLSX_SOURCE}</script>
<script id="sap-ui-bootstrap" src="${UI5_CORE}"
  data-sap-ui-theme="sap_horizon"
  data-sap-ui-libs="sap.m,sap.f"
  data-sap-ui-compat-version="edge"
  data-sap-ui-async="true"
  data-sap-ui-language="en"></script>
<script id="flp-app">
(function () {
  var C = ${scriptJson(cfg)}, L = C.L;
  sap.ui.require(['sap/ui/core/Core'], function (Core) { Core.ready().then(start); });
  function start() {
    sap.ui.require([
      'sap/m/App', 'sap/m/Page', 'sap/m/GenericTile', 'sap/m/TileContent', 'sap/m/ImageContent', 'sap/f/ShellBar', 'sap/ui/core/mvc/XMLView',
      'sap/ui/model/odata/v2/ODataModel', 'sap/ui/model/Filter', 'sap/ui/model/FilterOperator', 'sap/ui/model/Sorter', 'sap/m/ColumnListItem',
      'sap/m/Text', 'sap/ui/model/type/Date', 'sap/m/MessageToast', 'sap/m/Dialog', 'sap/m/Select', 'sap/ui/core/Item', 'sap/m/Label', 'sap/m/Button',
      'sap/m/VBox'
    ], function (App, Page, GenericTile, TileContent, ImageContent, ShellBar, XMLView, ODataModel, Filter, FilterOperator, Sorter, ColumnListItem,
      Text, DateType, MessageToast, Dialog, Select, Item, Label, Button, VBox) {
      var shellBar = new ShellBar('shellBar', { title: 'Home', navButtonPressed: function () { location.hash = ''; } });
      shellBar.placeAt('shell');
      var tile = new GenericTile('tileLineItems', {
        header: L.tile, subheader: 'Accounting', press: function () { location.hash = 'LineItem-manage'; },
        tileContent: [new TileContent({ content: new ImageContent({ src: 'sap-icon://list' }) })]
      }).addStyleClass('sapUiMediumMargin');
      var home = new Page('home', { showHeader: false, content: [tile] });
      var app = new App('shellApp', { pages: [home] });
      app.placeAt('content');
      var view = null, viewPromise = null;

      function utcMidnight(d) { return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); }
      function isoDate(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d == null ? '' : d); }
      function save(name, bytes) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: window.rpaXlsx.mime }));
        a.download = name; document.body.appendChild(a); a.click(); a.remove();
      }
      function loadedRows(table) {
        var b = table.getBinding('items');
        if (!b) return [];
        var contexts = b.getAllCurrentContexts ? b.getAllCurrentContexts() : b.getCurrentContexts();
        return contexts.map(function (c) {
          var r = c.getObject();
          return [r.Document, isoDate(r.PostingDate), r.CompanyCode, String(r.Amount), r.Currency];
        });
      }
      function exportRows(table) {
        var rows = loadedRows(table);
        if (!rows.length) { MessageToast.show('There is no data to export'); return; }
        save('LineItems.xlsx', window.rpaXlsx.xlsxBytes([C.header].concat(rows), 'Sheet1'));
      }

      function wire(v) {
        var table = v.byId('table'), co = v.byId('companyCode'), drs = v.byId('postingDate');
        var template = new ColumnListItem({ cells: [
          new Text({ text: '{Document}' }),
          new Text({ text: { path: 'PostingDate', type: new DateType({ style: 'medium', UTC: true }) } }),
          new Text({ text: '{CompanyCode}' }),
          new Text({ text: '{Amount}' }),
          new Text({ text: '{Currency}' })
        ] });
        v.byId('go').attachPress(function () {
          var company = co.getValue().trim(), from = drs.getDateValue(), to = drs.getSecondDateValue() || from;
          co.setValueState(company ? 'None' : 'Error');
          drs.setValueState(from ? 'None' : 'Error');
          if (!company || !from) { MessageToast.show('Fill in Company Code and Posting Date'); return; }
          // Edm.DateTime with sap:display-format="Date" is a UTC midnight: the filter values are built from the picked
          // calendar days in UTC, so a browser in any time zone sends datetime'yyyy-MM-ddT00:00:00'.
          table.bindItems({
            path: '/LineItems', template: template, templateShareable: true,
            sorter: new Sorter('PostingDate', false),
            filters: [new Filter({ and: true, filters: [
              new Filter('CompanyCode', FilterOperator.EQ, company),
              new Filter('PostingDate', FilterOperator.BT, utcMidnight(from), utcMidnight(to))
            ] })]
          });
        });
        var exp = v.byId('export');
        if (C.variant === 'dialog') {
          var format = new Select('exportFormat', { forceSelection: false, width: '100%', items: [
            new Item({ key: 'xlsx', text: 'Microsoft Excel Workbook (*.xlsx)' }),
            new Item({ key: 'pdf', text: 'Portable Document Format (*.pdf)' })
          ] });
          var dialog = new Dialog('exportDialog', {
            title: 'Export As', contentWidth: '24rem',
            content: [new VBox({ items: [new Label({ text: 'Format', labelFor: format, required: true }), format] }).addStyleClass('sapUiSmallMargin')],
            beginButton: new Button({ text: 'Export', type: 'Emphasized', press: function () {
              var key = format.getSelectedKey();
              if (key !== 'xlsx') {
                format.setValueState('Error');
                format.setValueStateText(key ? 'This format is not available' : 'Select a format');
                return;
              }
              format.setValueState('None');
              dialog.close();
              exportRows(table);
            } }),
            endButton: new Button({ text: 'Cancel', press: function () { dialog.close(); } })
          });
          v.addDependent(dialog);
          exp.attachPress(function () { dialog.open(); });
        } else exp.attachPress(function () { exportRows(table); });
        var layout = v.byId('exportLayout');
        if (layout) layout.attachPress(function () { save('layout.xlsx', window.rpaXlsx.xlsxBytes(C.layout, 'Sheet1')); });
      }

      function showApp() {
        shellBar.setTitle(L.tile); shellBar.setShowNavButton(true);
        if (view) { app.to(view); return; }
        if (viewPromise) return;
        viewPromise = XMLView.create({ id: C.viewId, definition: C.view }).then(function (v) {
          view = v;
          v.setModel(new ODataModel(C.service));
          wire(v);
          app.addPage(v);
          if (location.hash === '#LineItem-manage') app.to(v);
        });
      }
      function showHome() {
        shellBar.setTitle('Home'); shellBar.setShowNavButton(false);
        app.to(home);
      }
      function route() { if (location.hash === '#LineItem-manage') showApp(); else showHome(); }
      window.addEventListener('hashchange', route);
      route();
    });
  }
})();
</script></head>
<body class="sapUiBody" id="content-body"><div id="shell"></div><div id="content"></div></body></html>`;
}

// Returns true when the request was handled.
export async function fioriRealRoute(req, res, url, st, send) {
  if (url.pathname === FIORI_PATH && req.method === 'GET') {
    send(res, 200, page(st), { 'Cache-Control': 'no-store' });
    return true;
  }
  return false;
}
