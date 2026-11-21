import type { OpenAPIObject } from '@nestjs/swagger';

type HttpMethod =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'options'
  | 'head';

const HTTP_METHODS: HttpMethod[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
];

interface SchemaLike {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  description?: string;
  items?: SchemaLike;
  properties?: Record<string, SchemaLike>;
  allOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  anyOf?: SchemaLike[];
  required?: string[];
}

interface ParamLike {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie' | string;
  required?: boolean;
  description?: string;
  example?: unknown;
  schema?: SchemaLike;
}

interface OperationLike {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: ParamLike[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, { schema?: SchemaLike; example?: unknown }>;
  };
  responses?: Record<string, { description?: string }>;
}

const PARAM_DESCRIPTION_HINTS: Record<string, string> = {
  id: 'Unique resource identifier (MongoDB ObjectId)',
  tenantId: 'Workspace / company tenant identifier',
  userId: 'Team member user identifier',
  operatorId: 'Leadsetu HQ Super Admin operator identifier',
  requestId: 'Request record identifier',
  paymentId: 'Recorded payment transaction identifier',
  templateId: 'WhatsApp approved template ID or name',
  token: 'Signed public share / verification token',
  webhookKey: 'Workspace inbound lead webhook secret key',
  status: 'Filter records by lifecycle status',
  search: 'Case-insensitive keyword search across indexed fields',
  page: '1-indexed pagination page number',
  limit: 'Maximum number of records per page',
  severity: 'Filter logs by severity tier',
  action: 'Filter by audited event action name',
  type: 'Filter by record category or type',
  entityType: 'CRM entity type filter (lead, deal, contact, task, invoice)',
  entityId: 'Target CRM entity record ID',
  from: 'Inclusive ISO-8601 start date filter',
  to: 'Inclusive ISO-8601 end date filter',
};

function describeParameter(param: ParamLike): string {
  const existing = param.description?.trim();
  if (existing) return existing;

  const hinted = PARAM_DESCRIPTION_HINTS[param.name];
  if (hinted) return hinted;

  if (param.in === 'path') {
    return `Path parameter \`${param.name}\` identifying the target resource.`;
  }
  if (param.in === 'query') {
    return `Optional query parameter \`${param.name}\` to filter or paginate results.`;
  }
  if (param.in === 'header') {
    return `HTTP request header \`${param.name}\`.`;
  }
  return `Request parameter \`${param.name}\`.`;
}

function resolveSchemaRef(
  document: OpenAPIObject,
  schema: SchemaLike | undefined,
  seen = new Set<string>(),
): SchemaLike | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const match = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (!match) return schema;
    const schemaName = match[1];
    if (seen.has(schemaName)) return { type: 'object' };
    seen.add(schemaName);
    const resolved = document.components?.schemas?.[schemaName] as
      | SchemaLike
      | undefined;
    return resolved ? resolveSchemaRef(document, resolved, seen) : schema;
  }
  return schema;
}

function buildSampleFromSchema(
  document: OpenAPIObject,
  rawSchema: SchemaLike | undefined,
  depth = 0,
  seen = new Set<string>(),
): unknown {
  if (!rawSchema || depth > 5) return {};

  if (rawSchema.example !== undefined) return rawSchema.example;
  if (rawSchema.default !== undefined) return rawSchema.default;
  if (Array.isArray(rawSchema.enum) && rawSchema.enum.length > 0) {
    return rawSchema.enum[0];
  }

  if (rawSchema.$ref) {
    const match = rawSchema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) {
      const refName = match[1];
      if (seen.has(refName)) return {};
      const nextSeen = new Set(seen);
      nextSeen.add(refName);
      const target = document.components?.schemas?.[refName] as
        | SchemaLike
        | undefined;
      if (target) {
        return buildSampleFromSchema(document, target, depth + 1, nextSeen);
      }
    }
  }

  if (Array.isArray(rawSchema.allOf) && rawSchema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of rawSchema.allOf) {
      const partSample = buildSampleFromSchema(document, part, depth + 1, seen);
      if (
        partSample &&
        typeof partSample === 'object' &&
        !Array.isArray(partSample)
      ) {
        Object.assign(merged, partSample);
      }
    }
    return merged;
  }

  const union = rawSchema.oneOf ?? rawSchema.anyOf;
  if (Array.isArray(union) && union.length > 0) {
    return buildSampleFromSchema(document, union[0], depth + 1, seen);
  }

  if (rawSchema.type === 'array') {
    if (!rawSchema.items) return [];
    return [buildSampleFromSchema(document, rawSchema.items, depth + 1, seen)];
  }

  if (rawSchema.type === 'object' || rawSchema.properties) {
    const props = rawSchema.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      out[key] = buildSampleFromSchema(document, propSchema, depth + 1, seen);
    }
    return out;
  }

  if (rawSchema.type === 'number' || rawSchema.type === 'integer') return 0;
  if (rawSchema.type === 'boolean') return true;
  if (rawSchema.format === 'email') return 'founder@company.in';
  if (rawSchema.format === 'date-time') return '2026-11-21T10:30:00.000Z';
  if (rawSchema.format === 'date') return '2026-11-21';
  if (rawSchema.type === 'string') return 'string';
  return {};
}

function extractPathParamNames(pathPattern: string): string[] {
  const names: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pathPattern)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Normalizes and enriches the generated OpenAPI 3.0 document so Swagger UI and
 * Postman exports have zero blank descriptions, zero missing path parameters,
 * and zero duplicate raw Authorization header boxes on JWT-authenticated routes.
 */
export function sanitizeAndEnrichOpenApiDocument(
  document: OpenAPIObject,
  defaultServerUrl: string,
): OpenAPIObject {
  document.servers = [
    {
      url: defaultServerUrl,
      description: 'Leadsetu CRM Primary API Server',
    },
  ];

  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, OperationLike>
  >;

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const pathParamNames = extractPathParamNames(pathKey);

    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;

      const usesBearer =
        Array.isArray(op.security) &&
        op.security.some(
          (sec) => sec && Object.prototype.hasOwnProperty.call(sec, 'access-token'),
        );

      // Deduplicate parameters and drop redundant raw `authorization` header inputs
      const seenParams = new Map<string, ParamLike>();
      for (const param of op.parameters ?? []) {
        if (!param?.name) continue;
        const normalizedName = param.name.toLowerCase();
        if (
          usesBearer &&
          param.in === 'header' &&
          normalizedName === 'authorization'
        ) {
          continue;
        }
        const key = `${param.in}:${normalizedName}`;
        const enriched: ParamLike = {
          ...param,
          description: describeParameter(param),
          schema: param.schema ?? { type: 'string' },
        };
        if (!seenParams.has(key)) {
          seenParams.set(key, enriched);
        }
      }

      // Guarantee every `:param` / `{param}` in the URL exists in OpenAPI parameters
      for (const pName of pathParamNames) {
        const key = `path:${pName.toLowerCase()}`;
        if (!seenParams.has(key)) {
          seenParams.set(key, {
            name: pName,
            in: 'path',
            required: true,
            description: describeParameter({ name: pName, in: 'path', required: true }),
            schema: { type: 'string' },
          });
        }
      }

      op.parameters = Array.from(seenParams.values());

      // Populate crisp, useful operation descriptions if blank
      const tagLabel = op.tags?.[0] ?? 'Leadsetu API';
      const authNote = usesBearer
        ? 'Requires `Authorization: Bearer <accessToken>` header (use the Authorize button or `{{accessToken}}` in Postman).'
        : 'Public or webhook signature-verified endpoint (no CRM user Bearer JWT required).';

      if (!op.summary || !op.summary.trim()) {
        op.summary = `${method.toUpperCase()} ${pathKey}`;
      }

      if (!op.description || !op.description.trim()) {
        op.description = `${op.summary}.\n\n**Module:** ${tagLabel}  \n**Endpoint:** \`${method.toUpperCase()} ${pathKey}\`  \n**Auth:** ${authNote}`;
      }

      // Ensure requestBody description & JSON schema sample fallback exist
      if (op.requestBody?.content) {
        const jsonMedia = op.requestBody.content['application/json'];
        if (jsonMedia) {
          const resolved = resolveSchemaRef(document, jsonMedia.schema);
          if (
            resolved &&
            resolved.type === 'object' &&
            (!resolved.properties || Object.keys(resolved.properties).length === 0) &&
            !resolved.$ref
          ) {
            op.requestBody.description =
              op.requestBody.description || 'JSON request payload';
          }
          if (jsonMedia.example === undefined && resolved) {
            const sample = buildSampleFromSchema(document, jsonMedia.schema);
            if (
              sample &&
              typeof sample === 'object' &&
              Object.keys(sample as Record<string, unknown>).length > 0
            ) {
              jsonMedia.example = sample;
            }
          }
        }
      }

      // Ensure at least a 200/201 response description exists
      if (!op.responses || Object.keys(op.responses).length === 0) {
        const okStatus = method === 'post' ? '201' : '200';
        op.responses = {
          [okStatus]: { description: 'Operation completed successfully.' },
        };
      } else {
        for (const [statusCode, resp] of Object.entries(op.responses)) {
          if (resp && !resp.description) {
            resp.description = `HTTP ${statusCode} response`;
          }
        }
      }
    }
  }

  return document;
}

/**
 * Converts a sanitized OpenAPI 3.0 document into a ready-to-import
 * Postman Collection v2.1.0 JSON object with tag folders, `{{baseUrl}}`,
 * Bearer `{{accessToken}}`, path variables, query params, and sample bodies.
 */
export function convertOpenApiToPostmanCollection(
  document: OpenAPIObject,
  baseUrl: string,
): Record<string, unknown> {
  const folderMap = new Map<
    string,
    { name: string; description?: string; item: Record<string, unknown>[] }
  >();

  for (const tag of document.tags ?? []) {
    folderMap.set(tag.name, {
      name: tag.name,
      description: tag.description,
      item: [],
    });
  }

  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, OperationLike>
  >;

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;

      const folderName = op.tags?.[0] ?? 'General';
      if (!folderMap.has(folderName)) {
        folderMap.set(folderName, { name: folderName, item: [] });
      }

      const usesBearer =
        Array.isArray(op.security) &&
        op.security.some(
          (sec) => sec && Object.prototype.hasOwnProperty.call(sec, 'access-token'),
        );

      const postmanPath = rawPath.replace(/\{([^}]+)\}/g, ':$1');
      const pathSegments = postmanPath
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean);

      const queryParams: Array<Record<string, unknown>> = [];
      const pathVariables: Array<Record<string, unknown>> = [];
      const headers: Array<Record<string, unknown>> = [];

      for (const param of op.parameters ?? []) {
        const exampleVal =
          param.example !== undefined
            ? String(param.example)
            : param.schema?.example !== undefined
              ? String(param.schema.example)
              : param.schema?.default !== undefined
                ? String(param.schema.default)
                : '';

        if (param.in === 'query') {
          queryParams.push({
            key: param.name,
            value: exampleVal,
            description: param.description ?? '',
            disabled: !param.required,
          });
        } else if (param.in === 'path') {
          pathVariables.push({
            key: param.name,
            value: exampleVal || `<${param.name}>`,
            description: param.description ?? '',
          });
        } else if (param.in === 'header') {
          headers.push({
            key: param.name,
            value: exampleVal,
            description: param.description ?? '',
            disabled: !param.required,
          });
        }
      }

      let body: Record<string, unknown> | undefined;
      const jsonBody = op.requestBody?.content?.['application/json'];
      if (jsonBody) {
        if (!headers.some((h) => String(h.key).toLowerCase() === 'content-type')) {
          headers.push({ key: 'Content-Type', value: 'application/json' });
        }
        const sample =
          jsonBody.example !== undefined
            ? jsonBody.example
            : buildSampleFromSchema(document, jsonBody.schema);
        body = {
          mode: 'raw',
          raw: JSON.stringify(sample ?? {}, null, 2),
          options: {
            raw: {
              language: 'json',
            },
          },
        };
      }

      const rawUrl = `{{baseUrl}}${postmanPath.startsWith('/') ? '' : '/'}${postmanPath}`;
      const requestObj: Record<string, unknown> = {
        method: method.toUpperCase(),
        header: headers,
        url: {
          raw: rawUrl,
          host: ['{{baseUrl}}'],
          path: pathSegments,
          ...(queryParams.length > 0 ? { query: queryParams } : {}),
          ...(pathVariables.length > 0 ? { variable: pathVariables } : {}),
        },
        description: op.description ?? op.summary ?? '',
        ...(usesBearer
          ? {}
          : {
              auth: {
                type: 'noauth',
              },
            }),
        ...(body ? { body } : {}),
      };

      folderMap.get(folderName)!.item.push({
        name: op.summary || `${method.toUpperCase()} ${rawPath}`,
        request: requestObj,
        response: [],
      });
    }
  }

  return {
    info: {
      name: document.info.title || 'Leadsetu AI CRM — Backend API',
      description:
        `${document.info.description ?? ''}\n\n` +
        '### Quick Start in Postman\n' +
        '1. Set Collection Variable `baseUrl` (default: `' +
        baseUrl +
        '`).\n' +
        '2. Run **1. Auth & Workspace -> Login** (or **Register**) and paste `accessToken` into the `accessToken` Collection Variable.\n' +
        '3. All authenticated CRM endpoints inherit Bearer Auth automatically.',
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      version: document.info.version || '2.0.0',
    },
    auth: {
      type: 'bearer',
      bearer: [
        {
          key: 'token',
          value: '{{accessToken}}',
          type: 'string',
        },
      ],
    },
    variable: [
      {
        key: 'baseUrl',
        value: baseUrl,
        type: 'string',
        description: 'Leadsetu API base host (no trailing slash)',
      },
      {
        key: 'accessToken',
        value: '',
        type: 'string',
        description: 'JWT accessToken from POST /v1/auth/login',
      },
      {
        key: 'refreshToken',
        value: '',
        type: 'string',
        description: 'JWT refreshToken from POST /v1/auth/login',
      },
    ],
    item: Array.from(folderMap.values()).filter((f) => f.item.length > 0),
  };
}

export const SWAGGER_POSTMAN_CSS = `
  .ls-postman-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 16px 0 8px;
    padding: 14px 18px;
    border-radius: 12px;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    border: 1px solid #334155;
    color: #f8fafc;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
  }
  .ls-postman-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ls-postman-title {
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ls-postman-sub {
    font-size: 12px;
    color: #cbd5e1;
  }
  .ls-postman-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .ls-pm-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    border: 1px solid transparent;
    transition: transform 0.12s ease, opacity 0.12s ease, background 0.15s ease;
    font-family: inherit;
  }
  .ls-pm-btn:hover {
    transform: translateY(-1px);
    opacity: 0.96;
  }
  .ls-pm-primary {
    background: #ff6c37;
    color: #ffffff !important;
  }
  .ls-pm-secondary {
    background: rgba(255, 255, 255, 0.1);
    color: #f8fafc !important;
    border-color: rgba(255, 255, 255, 0.22);
  }
  .ls-pm-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.65);
    backdrop-filter: blur(4px);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .ls-pm-modal {
    width: 100%;
    max-width: 520px;
    background: #ffffff;
    color: #0f172a;
    border-radius: 14px;
    padding: 22px 24px;
    box-shadow: 0 24px 48px rgba(15, 23, 42, 0.28);
    font-family: system-ui, -apple-system, sans-serif;
  }
  .ls-pm-modal h3 {
    margin: 0 0 6px;
    font-size: 18px;
    font-weight: 700;
    color: #0f172a;
  }
  .ls-pm-modal p {
    margin: 0 0 14px;
    font-size: 13.5px;
    line-height: 1.5;
    color: #475569;
  }
  .ls-pm-url-box {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }
  .ls-pm-url-box input {
    flex: 1;
    padding: 8px 10px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    font-size: 12.5px;
    font-family: monospace;
    background: #f8fafc;
    color: #0f172a;
  }
  .ls-pm-steps {
    margin: 0 0 16px;
    padding-left: 18px;
    font-size: 13px;
    color: #334155;
    line-height: 1.55;
  }
  .ls-pm-modal-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
`;

export const SWAGGER_POSTMAN_JS = `
(function initLeadsetuPostmanBar() {
  function injectBar() {
    if (document.getElementById('ls-postman-bar')) return;
    var infoContainer =
      document.querySelector('.swagger-ui .information-container') ||
      document.querySelector('.swagger-ui .wrapper');
    if (!infoContainer) return;

    var origin = window.location.origin;
    var postmanUrl = origin + '/v1/docs-postman.json';
    var downloadUrl = origin + '/v1/docs-postman.json?download=1';
    var openApiUrl = origin + '/v1/docs-json';

    var bar = document.createElement('div');
    bar.id = 'ls-postman-bar';
    bar.className = 'ls-postman-bar';
    bar.innerHTML =
      '<div class="ls-postman-copy">' +
        '<div class="ls-postman-title">Leadsetu API Workspace &bull; OpenAPI 3.0 &amp; Postman v2.1</div>' +
        '<div class="ls-postman-sub">Every endpoint includes descriptions, path/query params, sample payloads, and Bearer JWT setup (<code>{{accessToken}}</code>).</div>' +
      '</div>' +
      '<div class="ls-postman-actions">' +
        '<button type="button" id="ls-open-postman-btn" class="ls-pm-btn ls-pm-primary">Open in Postman</button>' +
        '<a href="' + downloadUrl + '" class="ls-pm-btn ls-pm-secondary">Download Collection (.json)</a>' +
        '<button type="button" id="ls-copy-postman-url" class="ls-pm-btn ls-pm-secondary">Copy Import URL</button>' +
        '<a href="' + openApiUrl + '" target="_blank" rel="noopener noreferrer" class="ls-pm-btn ls-pm-secondary">OpenAPI JSON</a>' +
      '</div>';

    infoContainer.appendChild(bar);

    var copyBtn = document.getElementById('ls-copy-postman-url');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(postmanUrl).then(function () {
            copyBtn.textContent = 'Copied URL!';
            setTimeout(function () { copyBtn.textContent = 'Copy Import URL'; }, 1800);
          });
        }
      });
    }

    var openBtn = document.getElementById('ls-open-postman-btn');
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        var existing = document.getElementById('ls-pm-modal-backdrop');
        if (existing) existing.remove();

        var backdrop = document.createElement('div');
        backdrop.id = 'ls-pm-modal-backdrop';
        backdrop.className = 'ls-pm-modal-backdrop';
        backdrop.innerHTML =
          '<div class="ls-pm-modal" role="dialog" aria-modal="true">' +
            '<h3>Open Leadsetu API in Postman</h3>' +
            '<p>Import all tagged folders, sample JSON payloads, and pre-configured <code>{{baseUrl}}</code> + <code>{{accessToken}}</code> variables into Postman Desktop or Web:</p>' +
            '<div class="ls-pm-url-box">' +
              '<input type="text" readonly value="' + postmanUrl + '" id="ls-pm-modal-input" />' +
              '<button type="button" id="ls-pm-modal-copy" class="ls-pm-btn ls-pm-primary">Copy</button>' +
            '</div>' +
            '<ol class="ls-pm-steps">' +
              '<li>Click <strong>Launch Postman App</strong> below (or open Postman manually) and choose <strong>Import</strong>.</li>' +
              '<li>Paste the Collection URL above into Postman, <strong>or</strong> drag-and-drop the downloaded <code>leadsetu-crm-api.postman_collection.json</code> file.</li>' +
              '<li>Run <strong>1. Auth &amp; Workspace &rarr; Login</strong> and save your <code>accessToken</code> in Collection Variables.</li>' +
            '</ol>' +
            '<div class="ls-pm-modal-footer">' +
              '<button type="button" id="ls-pm-modal-close" class="ls-pm-btn ls-pm-secondary" style="color:#0f172a !important;border-color:#cbd5e1;">Close</button>' +
              '<a href="' + downloadUrl + '" class="ls-pm-btn ls-pm-secondary" style="color:#0f172a !important;border-color:#cbd5e1;">Download .json</a>' +
              '<a href="postman://app/import" class="ls-pm-btn ls-pm-primary">Launch Postman App</a>' +
            '</div>' +
          '</div>';

        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', function (e) {
          if (e.target === backdrop) backdrop.remove();
        });
        document.getElementById('ls-pm-modal-close').addEventListener('click', function () {
          backdrop.remove();
        });
        document.getElementById('ls-pm-modal-copy').addEventListener('click', function () {
          var input = document.getElementById('ls-pm-modal-input');
          input.select();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(postmanUrl);
          }
          this.textContent = 'Copied!';
        });
      });
    }
  }

  var observer = new MutationObserver(function () {
    injectBar();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    injectBar();
  } else {
    window.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.body, { childList: true, subtree: true });
      injectBar();
    });
  }
})();
`;
