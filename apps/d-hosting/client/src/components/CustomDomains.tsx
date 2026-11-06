import { useEffect, useState } from "react";

type CustomDomain = {
  id: string;
  domain: string;
  status: "pending" | "verified";
  verified_at: string | null;
  dns_record_name: string;
  dns_record_type: "TXT";
  dns_record_value: string;
};

type Props = {
  resourceUrl: string;
};

export default function CustomDomains({ resourceUrl }: Props) {
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function loadDomains() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${resourceUrl}/domains`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load domains.");
      setDomains(data.domains || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load domains.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDomains();
  }, [resourceUrl]);

  async function addDomain(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${resourceUrl}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domainInput }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not add domain.");
      setDomainInput("");
      setMessage(data.message || "Domain added.");
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add domain.");
    } finally {
      setSaving(false);
    }
  }

  async function verifyDomain(domain: CustomDomain) {
    setActiveId(domain.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `${resourceUrl}/domains/${domain.id}/verify`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Domain verification failed.");
      setMessage(data.message || "Domain verified.");
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Domain verification failed.");
    } finally {
      setActiveId("");
    }
  }

  async function removeDomain(domain: CustomDomain) {
    if (!window.confirm(`Remove ${domain.domain} from this website?`)) return;
    setActiveId(domain.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `${resourceUrl}/domains/${domain.id}`,
        { method: "DELETE" }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not remove domain.");
      setMessage(data.message || "Domain removed.");
      await loadDomains();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove domain.");
    } finally {
      setActiveId("");
    }
  }

  return (
    <section className="panel wb-panel">
      <div className="panel-heading">
        <div>
          <h2>Custom domains</h2>
          <p>Connect a domain you own and verify it with a DNS TXT record.</p>
        </div>
        <span className="wb-count">{domains.length} domains</span>
      </div>

      <form onSubmit={addDomain} className="wb-upload-panel">
        <input
          type="text"
          value={domainInput}
          onChange={(event) => setDomainInput(event.target.value)}
          placeholder="example.com"
          autoComplete="off"
          required
          maxLength={253}
          aria-label="Custom domain"
        />
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Adding..." : "Add domain"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      {loading ? (
        <p>Loading domains...</p>
      ) : domains.length === 0 ? (
        <p>No custom domains connected yet.</p>
      ) : (
        <div className="wb-file-list">
          {domains.map((domain) => (
            <article className="wb-file-row" key={domain.id}>
              <div className="wb-file-info">
                <strong>{domain.domain}</strong>
                <small>{domain.status === "verified" ? "Ownership verified" : "Verification pending"}</small>
                {domain.status === "pending" && (
                  <div>
                    <small>DNS record: {domain.dns_record_name}</small>
                    <small>Type: {domain.dns_record_type}</small>
                    <small>Value: {domain.dns_record_value}</small>
                  </div>
                )}
              </div>
              <div className="wb-file-actions">
                {domain.status === "pending" && (
                  <button
                    type="button"
                    disabled={activeId === domain.id}
                    onClick={() => void verifyDomain(domain)}
                  >
                    {activeId === domain.id ? "Checking..." : "Verify"}
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  disabled={activeId === domain.id}
                  onClick={() => void removeDomain(domain)}
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <p>
        Domain ownership verification does not activate DNS routing or HTTPS.
        Those require the hosting network and certificate setup.
      </p>
    </section>
  );
}
