BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS hosting_resources_id_project_unique
    ON hosting_resources (id, project_id);

CREATE TABLE IF NOT EXISTS hosting_custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    resource_id UUID NOT NULL,
    domain VARCHAR(253) NOT NULL,
    verification_token CHAR(64) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified')),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hosting_custom_domains_resource_project_fk
        FOREIGN KEY (resource_id, project_id)
        REFERENCES hosting_resources(id, project_id) ON DELETE RESTRICT,
    CONSTRAINT hosting_custom_domains_domain_unique UNIQUE (domain),
    CONSTRAINT hosting_custom_domains_resource_domain_unique UNIQUE (resource_id, domain)
);

CREATE INDEX IF NOT EXISTS hosting_custom_domains_resource_idx
    ON hosting_custom_domains (resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS hosting_custom_domains_project_idx
    ON hosting_custom_domains (project_id, created_at DESC);

COMMIT;
