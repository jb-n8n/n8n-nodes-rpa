// Fictional recall and stop-sale notices for the demo portal. Not real campaigns.
// Bulletin numbers are fixed so the n8n evidence check and the tests can assert on them;
// dates are relative to today so the digest always has something new to lead with.
const NOTICES = [
  { bulletin: 'N26-0417', daysAgo: 0, type: 'Stop-Sale', models: '2026 Acme Strider',
    title: 'Rear seat belt buckle may not latch',
    detail: 'The second-row centre buckle may not fully latch after repeated use. Do not deliver affected new or used units until the buckle assembly is replaced. Parts ship to dealers within 5 business days.' },
  { bulletin: 'N26-0412', daysAgo: 0, type: 'Recall', models: '2025-2026 Acme Hauler 1500',
    title: 'Tailgate may open while driving',
    detail: 'A tailgate latch cable can be routed incorrectly at the factory, allowing the tailgate to open unexpectedly. Dealers will inspect and reroute the cable. Remedy available now; owner letters mail next week.' },
  { bulletin: 'N26-0398', daysAgo: 3, type: 'Recall', models: '2025 Acme Ridgeback 1500',
    title: 'Instrument cluster may go blank',
    detail: 'A software fault can cause the cluster display to go blank at start-up, so warning lamps and speed are not shown. Dealers will reprogram the cluster module (about 30 minutes).' },
  { bulletin: 'N26-0391', daysAgo: 6, type: 'Stop-Sale', models: '2026 Acme Volta EV',
    title: 'Charge port door actuator can seize in cold weather',
    detail: 'Below -25 C the charge port door actuator may seize and prevent charging. Hold new-vehicle deliveries in affected regions until the updated actuator is installed.' },
  { bulletin: 'N26-0384', daysAgo: 11, type: 'Recall', models: '2025 Acme Harbor',
    title: 'Front passenger airbag label incorrect',
    detail: 'The sun visor airbag warning label may be printed in English only, which does not meet bilingual labelling requirements. Dealers will install a bilingual label.' },
  { bulletin: 'N26-0376', daysAgo: 18, type: 'Recall', models: '2026 Acme Mesa',
    title: 'Rear-view camera image may not display',
    detail: 'The rear-view camera image may not display when reverse is selected. Dealers will update the radio software. Some units can be updated over the air.' },
  { bulletin: 'N26-0369', daysAgo: 25, type: 'Recall', models: '2025 Acme Pioneer',
    title: 'Fuel pump module may fail',
    detail: 'A fuel pump module seal may leak internally, which can cause the engine to stall. Dealers will replace the fuel pump module. Interim loaner vehicles are authorized.' },
];

// Technical Service Bulletins: a decoy page the agent should recognize as not what it was sent for.
const TSBS = [
  { bulletin: 'SB-26-081', title: 'Squeak from dash area at low temperature', models: '2024-2026 Acme Voyager' },
  { bulletin: 'SB-26-077', title: 'Wireless charger intermittently inoperative', models: '2025 Acme Glacier' },
  { bulletin: 'SB-26-070', title: 'Infotainment reboot during Android Auto use', models: '2025-2026 Acme Strider' },
];

const iso = (d) => d.toISOString().slice(0, 10);

export function notices(now = new Date()) {
  return NOTICES.map(({ daysAgo, ...n }) => ({ ...n, date: iso(new Date(now.getTime() - daysAgo * 86400000)) }));
}
export const tsbs = () => TSBS;
export const BULLETINS = NOTICES.map((n) => n.bulletin);
