# Tools Reference

This MCP exposes **8 tools** under the `cz_cyber_` prefix.

---

## `cz_cyber_search_guidance`

Full-text search across NUKIB guidelines and technical standards.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `'kybernetická bezpečnost'`, `'NIS2'`, `'ISMS'`) |
| `type` | string | No | Filter by type: `guideline`, `standard`, `recommendation`, `regulation` |
| `series` | string | No | Filter by series: `NUKIB`, `NIS2`, `ISMS` |
| `status` | string | No | Filter by status: `current`, `superseded`, `draft` |
| `limit` | number | No | Max results (default: 20, max: 100) |

---

## `cz_cyber_get_guidance`

Retrieve a specific NUKIB guidance document by its reference identifier.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | NUKIB document reference (e.g., `'NUKIB-REK-2024-01'`) |

---

## `cz_cyber_search_advisories`

Search NUKIB security advisories and threat alerts.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `'ransomware'`, `'VPN'`, `'kritická zranitelnost'`) |
| `severity` | string | No | Filter: `critical`, `high`, `medium`, `low` |
| `limit` | number | No | Max results (default: 20, max: 100) |

---

## `cz_cyber_get_advisory`

Retrieve a specific NUKIB security advisory by reference.

**Input:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | Advisory reference (e.g., `'NUKIB-ADV-2024-001'`) |

---

## `cz_cyber_list_frameworks`

List all NUKIB framework series covered in this MCP.

**Input:** None

---

## `cz_cyber_about`

Return server metadata: version, data source, coverage summary, and tool list.

**Input:** None

---

## `cz_cyber_list_sources`

List all data sources with provenance metadata (name, authority, URL, scope, license, retrieval method).

**Input:** None

---

## `cz_cyber_check_data_freshness`

Check data freshness for each source. Reports record counts and the most recent document date to identify stale data.

**Input:** None

---

## Common Response Fields

All successful responses include a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "This data is provided for research purposes only...",
    "source_url": "https://www.nukib.cz/",
    "copyright": "Official NUKIB publications — Czech government public domain"
  }
}
```
