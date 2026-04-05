# Coverage

This document describes the corpus completeness of the Czech Cybersecurity MCP.

## Data Sources

### NUKIB Guidance Documents
- **Authority:** NUKIB (Národní úřad pro kybernetickou a informační bezpečnost)
- **URL:** https://www.nukib.cz/cs/kyberneticka-bezpecnost/
- **Scope:** National cybersecurity guidelines, technical standards, recommendations, NIS2 implementation guidance, ISMS standards, critical infrastructure protection requirements
- **Coverage:** Periodic ingestion — may lag official publications by days to weeks
- **License:** Public domain — official Czech government publications

### NUKIB Security Advisories
- **Authority:** NUKIB
- **URL:** https://www.nukib.cz/cs/infoservis/hrozby/
- **Scope:** Security advisories, vulnerability alerts, threat intelligence bulletins, CVE references
- **Coverage:** Periodic ingestion — may lag official publications
- **License:** Public domain — official Czech government publications

### NUKIB Cybersecurity Frameworks
- **Authority:** NUKIB
- **URL:** https://www.nukib.cz/
- **Scope:** National Cybersecurity Framework (Národní rámec kybernetické bezpečnosti), ISMS guidance, NIS2 implementation framework
- **Coverage:** Curated metadata — framework series index
- **License:** Public domain — official Czech government publications

## Known Limitations

- Coverage may be incomplete — not all NUKIB publications are ingested
- Data may lag official publications by days to weeks depending on ingestion schedule
- This is a **research tool** — always verify against primary NUKIB sources
- Older archived documents may not be included

## Freshness

Use the `cz_cyber_check_data_freshness` tool to check the most recent ingestion dates for each source.
