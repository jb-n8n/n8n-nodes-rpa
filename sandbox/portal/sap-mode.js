// Which SAP look-alike the portal serves: 'light' (erp.js, webgui.js, fiori.js) or 'realistic'. Read per request.
export const sapMode = () => (process.env.SANDBOX_SAP === 'realistic' ? 'realistic' : 'light');
// How the realistic look-alike signs in: 'sap' (the SAP system logon, the default), 'sso' (the identity provider in idp.js).
// Read per request. Light mode ignores it.
// 'sso2' is the same identity provider with an identity-first sign-in: email, Next, password, code, stay signed in.
export const sapLogin = () => (process.env.SANDBOX_SAP_LOGIN === 'sso' ? 'sso' : process.env.SANDBOX_SAP_LOGIN === 'sso2' ? 'sso2' : 'sap');
