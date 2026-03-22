import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["NUKIB_DB_PATH"] ?? "data/nukib.db";
const force = process.argv.includes("--force");
const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log("Deleted " + DB_PATH); }

const db = new Database(DB_PATH);
db.exec(SCHEMA_SQL);

const frameworks = [
  { id: "nukib-framework", name: "Narodni ramec kyberneticke bezpecnosti", name_en: "National Cybersecurity Framework", description: "NUKIB ramec pro ochranu informacnich systemu kriticke infrastruktury.", document_count: 5 },
  { id: "nis2-cz", name: "Implementace NIS2 v CR", name_en: "NIS2 Directive Implementation", description: "Pokyny pro implementaci smernice NIS2 v CR.", document_count: 1 },
  { id: "isms-series", name: "Rizeni bezpecnosti informaci (ISMS)", name_en: "Information Security Management System", description: "Dokumenty NUKIB k zavadeni ISMS.", document_count: 2 },
];

const guidance = [
  { reference: "NUKIB-P-01/2023", title: "Pozadavky na bezpecnost cloudovych sluzeb", title_en: "Cloud Service Security Requirements", date: "2023-03-15", type: "guideline", series: "NUKIB", summary: "Minimalni bezpecnostni pozadavky na cloudove sluzby pro organy verejne spravy.", full_text: "Pokyn NUKIB-P-01/2023\n\nPozadavky na cloudove sluzby\n1. Klasifikace dat pred migraci.\n2. Smluvni zaruky dostupnosti.\n3. Zalozni systemy a obnova.\n4. Auditovatelnost pristupu.\n5. Sifrovani dat.", topics: "cloud,bezpecnost", status: "current" },
  { reference: "NUKIB-P-02/2023", title: "Bezpecnost ICS/SCADA systemu", title_en: "ICS/SCADA Security", date: "2023-06-20", type: "standard", series: "NUKIB", summary: "Zabezpeceni prumyslovych ridicich systemu v energetice a vyrobe.", full_text: "Pokyn NUKIB-P-02/2023\n\nBezpecnost prumyslovych systemu\n1. Segmentace site OT/IT.\n2. Sprava privilegovanych pristupu.\n3. Aktualizace komponent.\n4. Detekce anomalii.\n5. Plany reakce na incidenty.", topics: "ICS,SCADA,OT", status: "current" },
  { reference: "NUKIB-D-01/2024", title: "Doporuceni pro MFA", title_en: "Multi-Factor Authentication Recommendations", date: "2024-01-10", type: "recommendation", series: "NUKIB", summary: "Zavedeni vicefaktorove autentizace v systemech verejne spravy.", full_text: "Doporuceni NUKIB-D-01/2024\n\nMFA je klic k zabezpeceni uctu.\nDoporucene metody: FIDO2, TOTP, hardverove tokeny.\nPovinnost pro administratory a vzdaleny pristup.", topics: "MFA,autentizace", status: "current" },
  { reference: "NUKIB-P-03/2024", title: "NIS2 - Pokyny pro provozovatele zakladnich sluzeb", title_en: "NIS2 Guidelines for Essential Service Operators", date: "2024-04-01", type: "regulation", series: "NIS2", summary: "Implementacni pokyny pro subjekty povinne dle zakona o kyberneticke bezpecnosti.", full_text: "Pokyn NUKIB-P-03/2024\n\nPovinnosti dle NIS2\n1. Registrace u NUKIB.\n2. ISMS.\n3. Hlaseni incidentu do 24/72 hodin.\n4. Rizika dodavatelskeho retezce.\n5. Penetracni testy.", topics: "NIS2,registrace,incident", status: "current" },
  { reference: "NUKIB-D-02/2024", title: "AI a kyberneticka bezpecnost", title_en: "AI and Cybersecurity Recommendations", date: "2024-09-15", type: "recommendation", series: "NUKIB", summary: "Bezpecne zavadeni systemu umele inteligence v kriticke infrastrukture.", full_text: "Doporuceni NUKIB-D-02/2024\n\nAI bezpecnost\n1. Posouzeni rizik pred nasazenim.\n2. Ochrana modelu.\n3. Monitoring vystupu.\n4. Soulad s AI Act.\n5. Zakaz neduveryhodnych AI v KII.", topics: "AI,umela inteligence", status: "current" },
];

const advisories = [
  { reference: "NUKIB-ALERT-2024-001", title: "Kriticka zranitelnost Microsoft Exchange Server", date: "2024-02-14", severity: "critical", affected_products: "Microsoft Exchange Server 2016, 2019", summary: "Aktivne zneuzivana zranitelnost CVE-2024-21410 umoznujici vzdalenou kompromitaci Exchange serveru.", full_text: "NUKIB-ALERT-2024-001\n\nPopis: Aktivni zneuzivani CVE-2024-21410 (NTLM Relay).\nOpatreni:\n1. Instalace KB5035106.\n2. Aktivace EPA.\n3. Monitoring NTLM logu.", cve_references: "CVE-2024-21410" },
  { reference: "NUKIB-ALERT-2024-002", title: "Phishingova kampan na ceske banky", date: "2024-05-08", severity: "high", affected_products: "Internetove bankovnictvi, mobilni aplikace", summary: "Sofistikovana phishingova kampan zamerejna na klienty ceskych bank.", full_text: "NUKIB-ALERT-2024-002\n\nOrganizovana phishingova kampan s falsymi bankovnimi portaly.\nTechniky: SMS phishing, podvodne domeny, presmerovani.\nSeznam IOC dostupny registrovanym subjektum.", cve_references: null },
  { reference: "NUKIB-ALERT-2024-003", title: "Ransomware LockBit 3.0 v prumyslovem sektoru", date: "2024-08-22", severity: "critical", affected_products: "Windows Server, ICS systemy", summary: "Narust ransomware utoku LockBit 3.0 na prumyslove podniky a KII v CR.", full_text: "NUKIB-ALERT-2024-003\n\nZvysena aktivita LockBit 3.0 v prumyslovem sektoru CR.\nVektory: RDP/VPN zranitelnosti, spear-phishing, kompromitace dodavatelu.\nOpatreni: offline zalohy, segmentace OT/IT, EDR, hlaseni do 24 hodin.", cve_references: null },
];

const iF = db.prepare("INSERT OR REPLACE INTO frameworks (id, name, name_en, description, document_count) VALUES (@id, @name, @name_en, @description, @document_count)");
const iG = db.prepare("INSERT OR REPLACE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (@reference, @title, @title_en, @date, @type, @series, @summary, @full_text, @topics, @status)");
const iA = db.prepare("INSERT OR REPLACE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (@reference, @title, @date, @severity, @affected_products, @summary, @full_text, @cve_references)");

for (const f of frameworks) iF.run(f);
for (const g of guidance) iG.run(g);
for (const a of advisories) iA.run(a);

console.log("Seeded " + frameworks.length + " frameworks, " + guidance.length + " guidance, " + advisories.length + " advisories into " + DB_PATH);
db.close();
