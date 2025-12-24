// =============================================================================
// Section: Imports & Types
// =============================================================================
// #region ImportsAndTypes
import * as SDK from "azure-devops-extension-sdk";
import type { IUserContext } from "azure-devops-extension-sdk";
import { getClient } from "azure-devops-extension-api";
import {
    CommonServiceIds,
    IHostNavigationService,
    IHostPageLayoutService,
} from "azure-devops-extension-api/Common/CommonServices";
import {
    IWorkItemFormService,
    WorkItemTrackingServiceIds,
} from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingServices";
import { BugsBehavior, TeamSetting } from "azure-devops-extension-api/Work";
import { TeamContext } from "azure-devops-extension-api/Core/Core";
import { WorkItemTrackingRestClient } from "azure-devops-extension-api/WorkItemTracking/WorkItemTrackingClient";
import {
    WorkItemTemplate,
    WorkItemTemplateReference,
    WorkItemTypeCategory,
} from "azure-devops-extension-api/WorkItemTracking";
import { CoreRestClient } from "azure-devops-extension-api/Core/CoreClient";

type ActionContext = {
    id?: number;
    workItemIds?: number[];
    tfsContext?: any;
};

type WorkItemFields = Record<string, any>;

type JsonPatch = {
    op: string;
    path: string;
    value?: any;
};
// #endregion ImportsAndTypes

// =============================================================================
// Section: Constants & Globals
// =============================================================================
// #region ConstantsAndGlobals

const CLIENT_TIMEOUT_MS = 8000;

SDK.init({ applyTheme: true });
WriteLog("Toolbar bundle loaded; waiting for SDK context.");

let initPromise: Promise<void> | null = null;
let webContext: ReturnType<typeof SDK.getWebContext> | null = null;
let witClient: WorkItemTrackingRestClient | null = null;
let coreClient: CoreRestClient | null = null;
let currentUser: IUserContext | null = null;
let cachedTeamContext: TeamContext | null = null;
let accessTokenPromise: Promise<string> | null = null;
let cachedCollectionUri: string | null = null;
// #endregion ConstantsAndGlobals

// =============================================================================
// Section: Initialization
// =============================================================================
// #region Initialization

/**
 * Initializes the Azure DevOps Extension SDK, caches clients and context,
 * resolves team context, and logs basic diagnostics. Safe to call multiple times.
 * @returns Promise resolved when initialization completes.
 */
function initialize(): Promise<void> {
    if (!initPromise) {
        WriteLog("Initializing Azure DevOps SDK context...");
        initPromise = SDK.ready().then(async () => {
            WriteLog("SDK.ready resolved; caching clients and context.");
            webContext = SDK.getWebContext();
            primeCollectionUriFromContext(SDK.getConfiguration());
            currentUser = SDK.getUser();
            witClient = getClient(WorkItemTrackingRestClient);
            coreClient = getClient(CoreRestClient);
            SDK.notifyLoadSucceeded();
            WriteLog("notifyLoadSucceeded dispatched; extension idle.");
            try {
                const cid = SDK.getContributionId && SDK.getContributionId();
                if (cid) {
                    WriteLog("Contribution id: " + cid);
                }
            } catch { }
            //await logNetworkDiagnostics();

            // Determine current context (project/team/user)
            if (webContext) {
                WriteLog(
                    "Web context: project=" +
                    (webContext.project?.name || 'unknown') +
                    ", team=" +
                    (webContext.team?.name || 'none') +
                    ", user=" +
                    (currentUser?.displayName || currentUser?.name || 'unknown')
                );
                await resolveTeamContext();
            }
        });
    } else {
        WriteLog("Reusing existing SDK initialization promise.");
    }
    return initPromise;
}

/**
 * Resolves and caches the `TeamContext` from the current `webContext`.
 * Falls back to Core API to load the project's default team if missing.
 * @returns Promise resolved after team context is set.
 */
async function resolveTeamContext(): Promise<void> {
    if (!webContext) {
        throw new Error("Cannot resolve team context without web context");
    }

    const baseContext: TeamContext = {
        projectId: webContext.project.id,
        project: webContext.project.name,
        teamId: webContext.team?.id,
        team: webContext.team?.name,
    };

    if (baseContext.teamId) {
        cachedTeamContext = baseContext;
        WriteLog(
            "Using team context from webContext: " +
            baseContext.team +
            " (" +
            baseContext.teamId +
            ")"
        );
        return;
    }

    WriteLog("WebContext missing team info; fetching default team via CoreRestClient...");
    if (!coreClient) {
        coreClient = getClient(CoreRestClient);
    }

    try {
        const project = await coreClient.getProject(baseContext.projectId, true, false);
        const defaultTeam = project?.defaultTeam;
        if (!defaultTeam?.id) {
            throw new Error("Project did not include a default team definition");
        }
        cachedTeamContext = {
            projectId: baseContext.projectId,
            project: baseContext.project,
            teamId: defaultTeam.id,
            team: defaultTeam.name,
        };
        WriteLog(
            "Resolved default team context: " +
            defaultTeam.name +
            " (" +
            defaultTeam.id +
            ")"
        );
    } catch (error) {
        const err = formatError(error);
        WriteLog("Failed to resolve default team context: " + err);
        throw error;
    }
}

/**
 * Returns the cached `TeamContext`. Throws if not yet initialized.
 * @returns Current `TeamContext` for project/team.
 */
function getTeamContext(): TeamContext {
    if (!cachedTeamContext) {
        throw new Error("Team context not available yet");
    }
    return cachedTeamContext;
}

// #endregion Initialization

// =============================================================================
// Section: Communication (Auth, Collection, REST)
// =============================================================================
// #region Communication

/**
 * Retrieves and caches the Azure DevOps access token from the SDK.
 * @returns Access token string for authenticated REST calls.
 */
async function getAccessToken(): Promise<string> {
    if (!accessTokenPromise) {
        accessTokenPromise = SDK.getAccessToken().catch((error) => {
            accessTokenPromise = null;
            throw error;
        });
    }
    return accessTokenPromise;
}

/**
 * Resolves the collection base URI from SDK configuration/page context or location.
 * @returns Collection URI ending with a trailing slash.
 */
function getCollectionUri(): string {
    if (!cachedCollectionUri) {
        primeCollectionUriFromContext(SDK.getConfiguration());
    }

    if (!cachedCollectionUri) {
        const pageContext = SDK.getPageContext() as any;
        primeCollectionUriFromContext(pageContext?.webContext);
        primeCollectionUriFromContext(pageContext);
    }

    if (!cachedCollectionUri) {
        const locationFallback = deriveUriFromLocation();
        if (locationFallback) {
            cachedCollectionUri = locationFallback;
        }
    }

    if (!cachedCollectionUri) {
        throw new Error("Unable to determine collection URI");
    }

    return cachedCollectionUri;
}

/**
 * Attempts to derive and cache the collection URI from a given context object.
 * No-op if already cached or context is missing.
 * @param context Arbitrary SDK/page context object.
 */
function primeCollectionUriFromContext(context: unknown): void {
    if (cachedCollectionUri || !context) {
        return;
    }

    const contextData = extractContextData(context);
    if (!contextData) {
        return;
    }

    const candidate =
        contextData?.collection?.uri ||
        contextData?.account?.uri ||
        contextData?.host?.uri ||
        contextData?.navigation?.publicAccessPoint?.uri ||
        contextData?.publicAccessPoint?.uri ||
        tryBuildUriFromHost(contextData?.host) ||
        tryBuildUriFromHost(contextData?.navigation?.serviceHost) ||
        tryBuildUriFromHost(contextData?.navigation?.collection) ||
        tryBuildUriFromHost(contextData?.navigation?.applicationServiceHost) ||
        tryBuildUriFromRelative(contextData?.collection?.relativeUri) ||
        tryBuildUriFromRelative(contextData?.account?.relativeUri) ||
        tryBuildUriFromRelative(contextData?.host?.relativeUri);

    if (candidate) {
        cachedCollectionUri = ensureTrailingSlash(candidate);
    }
}

/**
 * Extracts nested context data from various SDK/config shapes.
 * @param context Arbitrary SDK/config object.
 * @returns Normalized context-like object or null.
 */
function extractContextData(context: unknown): any {
    const anyContext = context as any;
    return (
        anyContext?.contextData ||
        anyContext?.tfsContext?.contextData ||
        anyContext?.tfsContext ||
        anyContext ||
        null
    );
}

/**
 * Constructs a URI from a host-like object containing scheme/authority/relative path.
 * @param hostLike Host-like structure from SDK page context.
 * @returns Absolute URI string or null if insufficient data.
 */
function tryBuildUriFromHost(hostLike: any): string | null {
    if (!hostLike) {
        return null;
    }
    if (typeof hostLike.uri === "string" && hostLike.uri) {
        return hostLike.uri;
    }

    const defaultProtocol =
        typeof window !== "undefined" && window.location?.protocol
            ? window.location.protocol
            : "https:";
    const scheme = (hostLike.scheme || hostLike.protocol || defaultProtocol).replace(/:$/, "");
    const authority = hostLike.authority || hostLike.host;
    if (!authority) {
        return null;
    }
    const relative = hostLike.relVDir || hostLike.relativeUri || hostLike.vDir || "";
    const normalizedAuthority = authority.replace(/\/+$/, "");
    const normalizedPath = relative
        ? relative.startsWith("/")
            ? relative
            : "/" + relative
        : "/";
    return scheme + "://" + normalizedAuthority + normalizedPath;
}

/**
 * Builds an absolute URI from a relative path using window.location origin.
 * @param relativeUri Relative URI string.
 * @returns Absolute URI or null if origin unavailable.
 */
function tryBuildUriFromRelative(relativeUri?: string | null): string | null {
    if (!relativeUri) {
        return null;
    }
    if (typeof window === "undefined" || !window.location) {
        return null;
    }
    const origin =
        window.location.origin ||
        (window.location.protocol + "//" + window.location.host);
    if (!origin) {
        return null;
    }
    const normalized = relativeUri.startsWith("/")
        ? relativeUri
        : "/" + relativeUri;
    return origin.replace(/\/+$/, "") + normalized;
}

/**
 * Derives a likely collection URI from the current window location by stripping route segments.
 * @returns Derived collection URI or null if not determinable.
 */
function deriveUriFromLocation(): string | null {
    if (typeof window === "undefined" || !window.location) {
        return null;
    }
    const origin =
        window.location.origin ||
        (window.location.protocol + "//" + window.location.host);
    if (!origin) {
        return null;
    }
    const segments = window.location.pathname
        .split("/")
        .filter((segment) => !!segment);
    const baseSegments: string[] = [];
    for (const segment of segments) {
        if (segment.startsWith("_")) {
            break;
        }
        baseSegments.push(segment);
    }
    const path = baseSegments.length ? "/" + baseSegments.join("/") + "/" : "/";
    return ensureTrailingSlash(origin.replace(/\/+$/, "") + path);
}

/**
 * Ensures a trailing slash on a URI string.
 * @param value URI string.
 * @returns URI ending with '/'.
 */
function ensureTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : value + "/";
}

/**
 * Returns the current project id and name from `webContext`.
 * @returns Object with `id` and `name`.
 */
function getProjectIds(): { id: string; name: string } {
    if (!webContext) {
        throw new Error("Web context not initialized");
    }
    return { id: webContext.project.id, name: webContext.project.name };
}

/**
 * Performs an authenticated fetch using the SDK token, handling headers and CORS.
 * Throws on non-OK responses and returns parsed JSON.
 * @typeParam T Expected JSON response type.
 * @param url Request URL.
 * @param init Optional fetch init options.
 * @returns Parsed JSON of type T.
 */
async function adoFetch<T>(url: string, init?: RequestInit): Promise<T> {
    const token = await getAccessToken();
    const headers = new Headers(init?.headers || undefined);
    if (!headers.has("Accept")) {
        headers.set("Accept", "application/json");
    }
    headers.set("Authorization", "Bearer " + token);
    headers.set("X-Requested-With", "XMLHttpRequest");

    const sameOrigin = (() => {
        try {
            if (typeof window === "undefined" || !window.location) return false;
            const requestOrigin = new URL(url).origin;
            return requestOrigin === window.location.origin;
        } catch {
            return false;
        }
    })();

    if (!sameOrigin) {
        headers.set("X-TFS-FedAuthRedirect", "Suppress");
    }

    const response = await fetch(url, {
        ...init,
        headers,
        credentials: sameOrigin ? "same-origin" : "omit",
        mode: sameOrigin ? "same-origin" : "cors",
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            "Request failed (" + response.status + "): " + response.statusText + " - " + text
        );
    }

    return (await response.json()) as T;
}

/**
 * Fetches a work item via REST with `$expand=all` for complete fields.
 * @param workItemId Work item id.
 * @returns Work item JSON.
 */
async function fetchWorkItemViaRest(workItemId: number): Promise<any> {
    const base = getCollectionUri();
    const url =
        base +
        "_apis/wit/workitems/" +
        workItemId +
        "?$expand=all&api-version=7.1-preview.3";
    WriteLog("Fetching work item via REST: " + url);
    return adoFetch<any>(url);
}

/**
 * Lists work item type categories for the current project via REST.
 * @returns Array of `WorkItemTypeCategory`.
 */
async function fetchWorkItemTypeCategoriesViaRest(): Promise<WorkItemTypeCategory[]> {
    const base = getCollectionUri();
    const { id } = getProjectIds();
    const url = base + encodeURIComponent(id) + "/_apis/wit/workitemtypecategories?api-version=7.1";
    WriteLog("Fetching categories via REST: " + url);
    try {
        const payload = await adoFetch<any>(url);
        const items = Array.isArray(payload) ? payload : payload?.value || [];
        const categories = items.map(normalizeCategoryPayload);
        try {
            WriteLog(
                "Categories fetched (" +
                categories.length +
                "): " +
                categories
                    .map((c) => c.name || c.referenceName || "unknown")
                    .join(", ")
            );
        } catch { }
        return categories;
    } catch (err) {
        WriteLog("Category list REST failed: " + formatError(err));
        throw err;
    }
}

/**
 * Fetches a single work item type category by reference name via REST.
 * @param referenceName Category reference name (e.g., `Microsoft.TaskCategory`).
 * @returns `WorkItemTypeCategory` payload.
 */
async function fetchWorkItemTypeCategoryViaRest(referenceName: string): Promise<WorkItemTypeCategory> {
    const base = getCollectionUri();
    const { id } = getProjectIds();
    const ref = encodeURIComponent(referenceName);
    const url = base + encodeURIComponent(id) + "/_apis/wit/workitemtypecategories/" + ref + "?api-version=7.1";
    WriteLog("Fetching category via REST: " + url);
    try {
        const payload = await adoFetch<any>(url);
        const normalized = normalizeCategoryPayload(payload);
        try {
            WriteLog(
                "Category fetched: " +
                (normalized.name || normalized.referenceName || referenceName)
            );
        } catch { }
        return normalized;
    } catch (err) {
        WriteLog("Category detail REST failed: " + formatError(err));
        throw err;
    }
}

/**
 * Retrieves backlog configuration for a given team context via REST
 * to derive `bugsBehavior`.
 * @param teamContext Team context with project/team.
 * @returns `TeamSetting` with normalized `bugsBehavior`.
 */
async function fetchBacklogConfigurationViaRest(
    teamContext: TeamContext
): Promise<TeamSetting> {
    if (!webContext) {
        throw new Error("Web context not initialized");
    }
    const base = getCollectionUri();
    const projectSeg = (webContext.project && webContext.project.name) || webContext.project.id;
    const teamSeg = teamContext.team || webContext.team?.name || teamContext.teamId || webContext.team?.id;

    if (!projectSeg || !teamSeg) {
        throw new Error("Missing project or team identifiers for backlog configuration");
    }

    const url =
        base +
        encodeURIComponent(projectSeg) +
        "/" + encodeURIComponent(teamSeg) +
        "/_apis/work/backlogconfiguration?api-version=7.1-preview.2";
    WriteLog("Fetching backlog configuration via REST: " + url);
    try {
        const payload = await adoFetch<any>(url);
        const behaviorStr = (payload && payload.bugsBehavior) || "Off";
        const normalized =
            behaviorStr === "AsRequirements"
                ? (BugsBehavior.AsRequirements as any)
                : behaviorStr === "AsTasks"
                    ? (BugsBehavior.AsTasks as any)
                    : (BugsBehavior.Off as any);
        return { bugsBehavior: normalized } as unknown as TeamSetting;
    } catch (err) {
        WriteLog("Backlog configuration REST failed: " + formatError(err));
        throw err;
    }
}

/**
 * Fetches team-scoped work item templates for the provided types via REST.
 * @param workItemTypes Work item type names to query.
 * @returns Array of template references.
 */
async function fetchTemplatesViaRest(
    workItemTypes: string[]
): Promise<WorkItemTemplateReference[]> {
    const base = getCollectionUri();
    const { id } = getProjectIds();
    const teamId = webContext!.team.id;
    const templates: WorkItemTemplateReference[] = [];
    for (const type of workItemTypes) {
        const typeEnc = encodeURIComponent(type);
        const url =
            base +
            encodeURIComponent(id) +
            "/" +
            encodeURIComponent(teamId) +
            "/_apis/wit/templates?workitemtypename=" +
            typeEnc +
            "&api-version=7.1";
        WriteLog("Fetching templates via REST: " + url);
        let list: any[] = [];
        try {
            const payload = await adoFetch<any>(url);
            list = Array.isArray(payload) ? payload : payload?.value || [];
        } catch (err) {
            WriteLog("Templates list REST failed for type " + type + ": " + formatError(err));
            throw err;
        }
        list.forEach((item: any) => {
            templates.push({
                id: item?.id,
                name: item?.name,
                description: item?.description,
                workItemTypeName: item?.workItemTypeName || type,
            } as any);
        });
    }
    return templates;
}

/**
 * Fetches template details by id via REST.
 * @param id Template id.
 * @returns Template payload.
 */
async function fetchTemplateViaRest(id: string): Promise<WorkItemTemplate> {
    const base = getCollectionUri();
    const { id: projectId } = getProjectIds();
    const teamId = webContext!.team.id;
    const templateId = encodeURIComponent(id);
    const url =
        base +
        encodeURIComponent(projectId) +
        "/" +
        encodeURIComponent(teamId) +
        "/_apis/wit/templates/" +
        templateId +
        "?api-version=7.1";
    WriteLog("Fetching template detail via REST: " + url);
    try {
        const payload = await adoFetch<any>(url);
        return (payload as unknown) as WorkItemTemplate;
    } catch (err) {
        WriteLog("Template detail REST failed: " + formatError(err));
        throw err;
    }
}

/**
 * Creates a work item via REST using JSON Patch document.
 * @param workItemTypeName Work item type name (e.g., `Task`).
 * @param document JSON Patch operations.
 * @returns Created work item payload.
 */
async function createWorkItemViaRest(
    workItemTypeName: string,
    document: JsonPatch[]
): Promise<any> {
    const base = getCollectionUri();
    const { id, name } = getProjectIds();
    const projectSeg = name || id;
    const url =
        base +
        encodeURIComponent(projectSeg) +
        "/_apis/wit/workitems/$" +
        encodeURIComponent(workItemTypeName) +
        "?api-version=7.1";
    const body = JSON.stringify(document);
    const init: RequestInit = {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json-patch+json",
            Accept: "application/json",
        },
        body,
    };
    WriteLog("Creating work item via REST: " + url);
    try {
        return await adoFetch<any>(url, init);
    } catch (err) {
        WriteLog("REST create failed: " + formatError(err));
        throw err;
    }
}

/**
 * Updates a work item’s links via REST using JSON Patch document.
 * @param workItemId Parent work item id.
 * @param document JSON Patch operations to add relations.
 * @returns Updated work item payload.
 */
async function updateWorkItemLinksViaRest(
    workItemId: number,
    document: JsonPatch[]
): Promise<any> {
    const base = getCollectionUri();
    const { id, name } = getProjectIds();
    const projectSeg = name || id;
    const url =
        base +
        encodeURIComponent(projectSeg) +
        "/_apis/wit/workitems/" +
        workItemId +
        "?api-version=7.1";
    const body = JSON.stringify(document);
    const init: RequestInit = {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json-patch+json",
            Accept: "application/json",
        },
        body,
    };
    WriteLog("Updating work item links via REST: " + url);
    try {
        return await adoFetch<any>(url, init);
    } catch (err) {
        WriteLog("REST update failed: " + formatError(err));
        throw err;
    }
}
// #endregion Communication

// =============================================================================
// Section: Utilities (logging, helpers)
// =============================================================================
// #region Utilities

/**
 * Logs a namespaced message to the console for this extension.
 * @param msg Message to log.
 */
function WriteLog(msg: string): void {
    console.log("Create Child Tasks: " + msg);
}

/**
 * Normalizes unknown error values to a readable message string.
 * @param error Unknown error value.
 * @returns Error message string.
 */
function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    } catch (_err) {
        return String(error);
    }
}

/**
 * Logs host and network diagnostics and probes `_apis/connectionData` for connectivity.
 * Useful for troubleshooting extension environment issues.
 * @returns Promise resolved after diagnostics complete.
 */
async function logNetworkDiagnostics(): Promise<void> {
    try {
        const loc = typeof window !== 'undefined' ? window.location.href : 'n/a';
        const base = (() => {
            try { return getCollectionUri(); } catch { return 'unresolved'; }
        })();
        const pageContext = SDK.getPageContext() as any;
        const host = (pageContext?.webContext?.host || pageContext?.host || {}) as any;
        const publicPoint = host?.publicAccessPoint?.uri || host?.uri || 'unknown';
        const sameOrigin = (() => {
            try { return new URL(base).origin === new URL(loc).origin; } catch { return false; }
        })();
        WriteLog(
            'Diagnostics: location=' + loc + ', collectionUri=' + base +
            ', hostPublicAccessPoint=' + publicPoint + ', sameOrigin=' + sameOrigin
        );
        if (typeof base === 'string' && base !== 'unresolved') {
            const url = base + '_apis/connectionData?connectOptions=IncludeServices&lastChangeId=-1&lastChangeId64=-1';
            WriteLog('Diagnostics: probing connectionData ' + url);
            try {
                const result = await adoFetch<any>(url);
                const svcCount = Array.isArray(result?.locationServiceData?.serviceDefinitions)
                    ? result.locationServiceData.serviceDefinitions.length
                    : 0;
                WriteLog('Diagnostics: connectionData OK; services=' + svcCount);
            } catch (err) {
                WriteLog('Diagnostics: connectionData failed: ' + formatError(err));
            }
        }
    } catch (e) {
        WriteLog('Diagnostics: failed: ' + formatError(e));
    }
}

/**
 * Logs a concise summary of a work item (id, type, title, state, assigned, area, iteration).
 * @param source Label indicating source (REST/CLIENT).
 * @param workItem Work item payload.
 */
function logWorkItemBasicInfo(source: string, workItem: any): void {
    try {
        const fields = (workItem && workItem.fields) || {};
        const id = workItem && (workItem.id || fields["System.Id"]);
        const type = fields["System.WorkItemType"];
        const title = fields["System.Title"];
        const state = fields["System.State"];
        const assignedRaw = fields["System.AssignedTo"];
        const assigned =
            typeof assignedRaw === "string"
                ? assignedRaw
                : assignedRaw && (assignedRaw.displayName || assignedRaw.name || assignedRaw.uniqueName);
        const area = fields["System.AreaPath"];
        const iteration = fields["System.IterationPath"];
        WriteLog(
            "Work item (" +
            source +
            "): id=" +
            id +
            ", type=" +
            (type || "unknown") +
            ", state=" +
            (state || "unknown") +
            ", title=" +
            (title || "unknown") +
            ", assignedTo=" +
            (assigned || "none") +
            ", area=" +
            (area || "unknown") +
            ", iteration=" +
            (iteration || "unknown")
        );
    } catch (e) {
        try {
            WriteLog("Failed to log work item basic info: " + formatError(e));
        } catch { }
    }
}

/**
 * Sort comparator for template references by name (case-insensitive).
 * @param a First template reference.
 * @param b Second template reference.
 * @returns Negative/zero/positive per standard comparator.
 */
function sortTemplates(
    a: WorkItemTemplateReference,
    b: WorkItemTemplateReference
): number {
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();
    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
}

/**
 * Attempts to extract and parse the first valid JSON object from an arbitrary string.
 * @param str Source string.
 * @param label Label used for logging.
 * @returns Tuple [object, startIndex, endIndex] or null.
 */
function extractJSON(str: string | undefined, label: string): any[] | null {
    if (!str) {
        return null;
    }
    let firstOpen = str.indexOf("{");
    let firstClose = -1;
    let candidate: string;
    let attempts = 0;
    let lastError: string | null = null;

    if (firstOpen === -1) {
        return null;
    }

    do {
        firstClose = str.lastIndexOf("}");
        if (firstClose <= firstOpen) {
            if (attempts > 0 && lastError) {
                WriteLog(
                    'Failed to parse JSON for template "' +
                    label +
                    '" after ' +
                    attempts +
                    " attempts. Last error: " +
                    lastError
                );
            }
            return null;
        }
        do {
            candidate = str.substring(firstOpen, firstClose + 1);
            try {
                const res = JSON.parse(candidate);
                return [res, firstOpen, firstClose + 1];
            } catch (e) {
                attempts++;
                lastError = e instanceof Error ? e.message : String(e);
            }
            firstClose = str.substring(0, firstClose).lastIndexOf("}");
        } while (firstClose > firstOpen);
        firstOpen = str.indexOf("{", firstOpen + 1);
    } while (firstOpen !== -1);

    if (attempts > 0 && lastError) {
        WriteLog(
            'Failed to parse JSON for template "' +
            label +
            '" after ' +
            attempts +
            " attempts. Last error: " +
            lastError
        );
    }
    return null;
}

/**
 * Performs case-insensitive wildcard matching with `*` across the entire string.
 * @param str Input string.
 * @param rule Wildcard rule.
 * @returns True if matched.
 */
function matchWildcardString(str: string, rule: string): boolean {
    const escapeRegex = (value: string) =>
        value.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
    const regex = new RegExp(
        "^" +
        rule
            .split("*")
            .map((segment) => escapeRegex(segment))
            .join(".*") +
        "$",
        "i"
    );
    return regex.test(str);
}

/**
 * Matches a single field value in `currentWorkItem` against a filter element’s criteria.
 * Supports wildcards for `System.Title` and multi-tags for `System.Tags`.
 * @param fieldName Field name.
 * @param currentWorkItem Current work item fields.
 * @param filterElement Filter rule element.
 * @returns True if the field matches or rule not specified.
 */
function matchField(
    fieldName: string,
    currentWorkItem: WorkItemFields,
    filterElement: Record<string, any>
): boolean {
    const filterVal = filterElement[fieldName];
    if (typeof filterVal === "undefined" || filterVal === null) {
        return true;
    }

    const curValRaw = currentWorkItem ? currentWorkItem[fieldName] : undefined;

    if (fieldName === "System.Title") {
        const title = curValRaw == null ? "" : curValRaw.toString();
        const rule = filterVal == null ? "" : filterVal.toString();
        return matchWildcardString(title, rule);
    }

    if (fieldName === "System.Tags") {
        const toTagArray = (val: any): string[] => {
            if (Array.isArray(val)) return val;
            if (val == null) return [];
            return val
                .toString()
                .split(/[;,\n]/)
                .map((s: string) => s.trim())
                .filter((s: string) => s)
                .map((s: string) => s.toLowerCase());
        };

        const currentTags = toTagArray(curValRaw);
        const filterTags = toTagArray(filterVal);
        return filterTags.every((tag) => currentTags.indexOf(tag) !== -1);
    }

    if (Array.isArray(filterVal)) {
        const curStr = curValRaw == null ? "" : curValRaw.toString().toLowerCase();
        return filterVal.some(
            (value) =>
                (value == null ? "" : value.toString().toLowerCase()) === curStr
        );
    }

    if (curValRaw == null) {
        return false;
    }

    return (
        filterVal.toString().toLowerCase() === curValRaw.toString().toLowerCase()
    );
}

/**
 * Validates whether a template field key should be applied.
 * Rejects tags and special placeholders like `@me`/`@currentiteration`.
 * @param taskTemplate Template payload.
 * @param key Field name.
 * @returns True if valid to apply.
 */
function isPropertyValid(taskTemplate: WorkItemTemplate, key: string): boolean {
    const fields = taskTemplate.fields || {};
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
        return false;
    }
    if (key.indexOf("System.Tags") >= 0) {
        return false;
    }
    const value = fields[key];
    if (typeof value === "string") {
        const lowered = value.toLowerCase();
        if (lowered === "@me" || lowered === "@currentiteration") {
            return false;
        }
    }
    return true;
}

/**
 * Safely returns template name or `unknown`.
 * @param taskTemplate Template payload.
 * @returns Template name string.
 */
function getTemplateName(taskTemplate: WorkItemTemplate): string {
    return taskTemplate && taskTemplate.name ? taskTemplate.name : "unknown";
}

/**
 * Replaces `{ParentField}` placeholders within a string using values from the current work item.
 * @param fieldValue Source string possibly containing placeholders.
 * @param currentWorkItem Current work item fields.
 * @returns Updated string with placeholders replaced.
 */
function replaceReferenceToParentField(
    fieldValue: string,
    currentWorkItem: WorkItemFields
): string {
    const filters = fieldValue.match(/[^{\}]+(?=})/g);
    if (!filters) {
        return fieldValue;
    }
    let updatedValue = fieldValue;
    filters.forEach((parentField) => {
        const parentValue = currentWorkItem[parentField];
        updatedValue = updatedValue.replace("{" + parentField + "}", parentValue);
    });
    return updatedValue;
}

/**
 * Finds the work item type category that includes the specified type.
 * @param categories List of categories.
 * @param workItemType Work item type name.
 * @returns Matching category or undefined.
 */
function findWorkTypeCategory(categories: WorkItemTypeCategory[], workItemType: string): WorkItemTypeCategory | undefined {
    return categories.find((category) =>
        category.workItemTypes.some((type) => type.name === workItemType)
    );
}

/**
 * Wraps a promise with a timeout, rejecting with a descriptive error if exceeded.
 * @typeParam T Promise value type.
 * @param promise Source promise.
 * @param label Label used in timeout error.
 * @param timeoutMs Timeout in milliseconds.
 * @returns Promise resolving/rejecting as original or timeout error.
 */
function withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs = CLIENT_TIMEOUT_MS
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(label + " timed out after " + timeoutMs + "ms"));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timeoutId);
                resolve(value);
            },
            (error) => {
                clearTimeout(timeoutId);
                reject(error);
            }
        );
    });
}
// #endregion Utilities

// =============================================================================
// Section: Workflow (run, create, addTasks...)
// =============================================================================
// #region Workflow

/**
 * Entry point for toolbar actions: primes collection URI, initializes SDK,
 * and dispatches to `create` flow.
 * @param context Action context (id/workItemIds/tfsContext).
 */
async function run(context: ActionContext): Promise<void> {
    primeCollectionUriFromContext(context);
    try {
        await initialize();
        await create(context);
    } catch (error) {
        WriteLog("Unhandled error: " + formatError(error));
    }
}

/**
 * Determines if an active work item form is open and triggers form workflow.
 * Grid workflow is not supported.
 * @param context Action context.
 */
async function create(context: ActionContext): Promise<void> {
    WriteLog("Determining action context (Form vs Grid)...");
    const service = await SDK.getService<IWorkItemFormService>(
        WorkItemTrackingServiceIds.WorkItemFormService
    );

    const hasActiveWorkItem = await service.hasActiveWorkItem();

    if (hasActiveWorkItem) {
        WriteLog("Active work item detected; running Form workflow");
        await addTasksOnForm(service);
        return;
    }
    
    WriteLog("Form workflow only; open a work item and retry.");
    return;
}

/**
 * Form-only workflow: gets active work item id and delegates to `addTasks`.
 * @param service Work item form service.
 */
async function addTasksOnForm(service: IWorkItemFormService): Promise<void> {
    const workItemId = await service.getId();
    WriteLog("Form work item id: " + workItemId);
    if (typeof workItemId === "number") {
        await addTasks(workItemId, service);
    }
}

/**
 * Main workflow: fetches parent work item, resolves child types, loads templates,
 * and creates child items, linking them to the parent.
 * @param workItemId Parent work item id.
 * @param service Work item form service when present; null otherwise.
 */
async function addTasks(
    workItemId: number,
    service: IWorkItemFormService | null
): Promise<void> {
    WriteLog(
        "Preparing to add tasks for work item " +
        workItemId +
        (service ? " (form)" : " (grid)")
    );
    if (!webContext || !witClient) {
        WriteLog("Clients/context missing; triggering initialize().");
        await initialize();
    }

    const workItem = await getWorkItem(workItemId);
    const currentWorkItem: WorkItemFields = {
        ...(workItem.fields || {}),
        "System.Id": workItemId,
    };

    const workItemType = currentWorkItem["System.WorkItemType"];
    if (!workItemType) {
        WriteLog("Unable to determine work item type for id " + workItemId);
        return;
    }
    WriteLog("Work item type: " + workItemType);

    const teamSettings: TeamSetting = { bugsBehavior: BugsBehavior.Off } as unknown as TeamSetting;

    const childTypes = await getChildTypes(workItemType);

    if (!childTypes || !childTypes.length) {
        WriteLog("No child types returned for type " + workItemType);
        return;
    }

    const templates = await getTemplates(childTypes);
    WriteLog("Template count: " + templates.length);
    if (!templates.length) {
        const message =
            "No " +
            childTypes.join(", ") +
            " templates found. Please add " +
            childTypes.join(", ") +
            " templates for the project team.";
        await showDialog(message);
        return;
    }

    const orderedTemplates = templates.sort(sortTemplates);
    WriteLog(
        "Processing templates: " + orderedTemplates.map((t) => t.name).join(", ")
    );
    for (const template of orderedTemplates) {
        await createChildFromTemplate(service, currentWorkItem, template, teamSettings);
    }
}

/**
 * Retrieves a work item by id, preferring REST and falling back to client if needed.
 * @param workItemId Work item id.
 * @returns Work item JSON payload.
 */
async function getWorkItem(workItemId: number): Promise<any> {
    if (!witClient) {
        await initialize();
    }
    try {
        WriteLog("Getting work item " + workItemId);
        const workItem = await fetchWorkItemViaRest(workItemId);
        logWorkItemBasicInfo("REST", workItem);
        return workItem;
    } catch (restError) {
        WriteLog(
            "REST work item fetch failed: " +
            formatError(restError) +
            "; attempting client call as fallback"
        );
    }
}
// #endregion Workflow

// =============================================================================
// Section: Templates + Work Item Processing
// =============================================================================
// #region TemplatesAndProcessing

/**
 * Loads team templates for the provided child work item types.
 * REST-only; returns empty array on failure.
 * @param workItemTypes Child type names.
 * @returns Array of template references.
 */
async function getTemplates(
    workItemTypes: string[]
): Promise<WorkItemTemplateReference[]> {
    if (!webContext || !witClient) {
        WriteLog("getTemplates missing context/client; reinitializing.");
        await initialize();
    }
    try {
        return await fetchTemplatesViaRest(workItemTypes);
    } catch (restError) {
        WriteLog(
            "Templates REST fetch failed: " +
            formatError(restError) +
            "; no fallback (REST-only)."
        );
        return [];
    }
}

/**
 * Retrieves a template detail via REST.
 * @param id Template id.
 * @returns Template payload.
 */
async function getTemplate(id: string): Promise<WorkItemTemplate> {
    if (!webContext) {
        await initialize();
    }
    WriteLog("Fetching template details via REST for id " + id);
    return fetchTemplateViaRest(id);
}

/**
 * Converts a template and parent work item context into a JSON Patch document
 * for creating a child work item.
 * @param currentWorkItem Parent work item fields.
 * @param taskTemplate Template payload.
 * @param teamSettings Team settings for iteration handling.
 * @returns JSON Patch operations for creation.
 */
function createWorkItemFromTemplate(
    currentWorkItem: WorkItemFields,
    taskTemplate: WorkItemTemplate,
    teamSettings: TeamSetting
): JsonPatch[] {
    const workItem: JsonPatch[] = [];
    const fields = taskTemplate.fields || {};

    Object.keys(fields).forEach((key) => {
        if (!isPropertyValid(taskTemplate, key)) {
            return;
        }
        const templateValue = fields[key];
        if (!templateValue && currentWorkItem[key] != null) {
            workItem.push({
                op: "add",
                path: "/fields/" + key,
                value: currentWorkItem[key],
            });
            return;
        }

        let fieldValue = templateValue;
        fieldValue = replaceReferenceToParentField(fieldValue, currentWorkItem);
        workItem.push({ op: "add", path: "/fields/" + key, value: fieldValue });
    });

    if (fields["System.Title"] == null && currentWorkItem["System.Title"] != null) {
        workItem.push({
            op: "add",
            path: "/fields/System.Title",
            value: currentWorkItem["System.Title"],
        });
    }

    if (
        fields["System.AreaPath"] == null &&
        currentWorkItem["System.AreaPath"] != null
    ) {
        workItem.push({
            op: "add",
            path: "/fields/System.AreaPath",
            value: currentWorkItem["System.AreaPath"],
        });
    }

    if (fields["System.IterationPath"] == null) {
        workItem.push({
            op: "add",
            path: "/fields/System.IterationPath",
            value: currentWorkItem["System.IterationPath"],
        });
    } else if (
        typeof fields["System.IterationPath"] === "string" &&
        fields["System.IterationPath"].toLowerCase() === "@currentiteration"
    ) {
        const backlogName = teamSettings?.backlogIteration?.name || "";
        const defaultPath = teamSettings?.defaultIteration?.path;
        if (defaultPath) {
            WriteLog(
                "Info: Creating work item (template: " +
                getTemplateName(taskTemplate) +
                ") with team default iteration path."
            );
            const iterationPath = backlogName ? backlogName + defaultPath : defaultPath;
            workItem.push({
                op: "add",
                path: "/fields/System.IterationPath",
                value: iterationPath,
            });
        } else {
            WriteLog(
                "Warning: No default iteration path defined; using parent iteration."
            );
            workItem.push({
                op: "add",
                path: "/fields/System.IterationPath",
                value: currentWorkItem["System.IterationPath"],
            });
        }
    }

    if (typeof fields["System.AssignedTo"] === "string") {
        const lowered = fields["System.AssignedTo"].toLowerCase();
        if (lowered === "@me" && currentUser) {
            const assignedTo = currentUser.name || currentUser.displayName;
            if (assignedTo) {
                workItem.push({
                    op: "add",
                    path: "/fields/System.AssignedTo",
                    value: assignedTo,
                });
            } else {
                WriteLog("Warning: Unable to resolve current user for assignment.");
            }
        }
    }

    if (fields["System.Tags-Add"] != null) {
        workItem.push({
            op: "add",
            path: "/fields/System.Tags",
            value: fields["System.Tags-Add"],
        });
    }

    return workItem;
}

/**
 * Creates a child work item using REST (with client fallback) and links it to the parent.
 * Saves the form when available.
 * @param service Work item form service or null.
 * @param currentWorkItem Parent fields.
 * @param taskTemplate Template payload.
 * @param teamSettings Team settings for iteration handling.
 */
async function createWorkItem(
    service: IWorkItemFormService | null,
    currentWorkItem: WorkItemFields,
    taskTemplate: WorkItemTemplate,
    teamSettings: TeamSetting
): Promise<void> {

    if (!webContext || !witClient) {
        WriteLog("createWorkItem missing context/client; reinitializing.");
        await initialize();
    }

    const newWorkItem = createWorkItemFromTemplate(
        currentWorkItem,
        taskTemplate,
        teamSettings
    );
    WriteLog(
        'Creating work item from template "' +
        getTemplateName(taskTemplate) +
        '" with ' +
        newWorkItem.length +
        " patch operations"
    );
    let created: any;
    try {
        created = await createWorkItemViaRest(taskTemplate.workItemTypeName, newWorkItem);
    } catch (restError) {
        WriteLog(
            "REST createWorkItem failed: " +
            formatError(restError) +
            "; attempting client call as fallback"
        );
        try {
            created = await withTimeout(
                witClient!.createWorkItem(
                    newWorkItem,
                    webContext!.project.name!,
                    taskTemplate.workItemTypeName
                ),
                "createWorkItem"
            );
        } catch (error) {
            WriteLog("createWorkItem via client also failed or timed out: " + formatError(error));
            throw error;
        }
    }

    if (service) {
        if (created.url) {
            await service.addWorkItemRelations([
                {
                    rel: "System.LinkTypes.Hierarchy-Forward",
                    url: created.url,
                    attributes: { isLocked: false },
                },
            ]);
            WriteLog("Linked new child " + created.id + " to parent via form service.");
        }
        if (typeof service.save === "function") {
            await service.save();
            WriteLog("Form saved after relation addition.");
        }
        return;
    }

    if (!created.url) {
        return;
    }

    const document: JsonPatch[] = [
        {
            op: "add",
            path: "/relations/-",
            value: {
                rel: "System.LinkTypes.Hierarchy-Forward",
                url: created.url,
                attributes: {
                    isLocked: false,
                },
            },
        },
    ];
    try {
        await updateWorkItemLinksViaRest(currentWorkItem["System.Id"], document);
    } catch (restError) {
        WriteLog(
            "REST update links failed: " +
            formatError(restError) +
            "; attempting client call as fallback"
        );
        try {
            await withTimeout(
                witClient!.updateWorkItem(document, currentWorkItem["System.Id"]),
                "updateWorkItem"
            );
        } catch (error) {
            WriteLog("updateWorkItem via client also failed or timed out: " + formatError(error));
            throw error;
        }
    }
    const navigationService = await SDK.getService<IHostNavigationService>(
        CommonServiceIds.HostNavigationService
    );
    await navigationService.reload();
    WriteLog("Grid scenario: parent work item updated and page reloaded.");
}

/**
 * Loads a template by reference and creates a child if it matches filters.
 * @param service Work item form service or null.
 * @param currentWorkItem Parent work item fields.
 * @param template Template reference.
 * @param teamSettings Team settings for iteration handling.
 */
async function createChildFromTemplate(
    service: IWorkItemFormService | null,
    currentWorkItem: WorkItemFields,
    template: WorkItemTemplateReference,
    teamSettings: TeamSetting
): Promise<void> {
    try {
        const taskTemplate = await getTemplate(template.id);
        if (
            isValidTemplateWIT(currentWorkItem, taskTemplate) &&
            isValidTemplateTitle(currentWorkItem, taskTemplate)
        ) {
            await createWorkItem(service, currentWorkItem, taskTemplate, teamSettings);
            WriteLog(
                'Created child from template "' +
                template.name +
                '" for parent ' +
                currentWorkItem["System.Id"]
            );
        }
    } catch (error) {
        WriteLog(
            'Failed to create child from template "' +
            template.name +
            '" (id: ' +
            template.id +
            "): " +
            formatError(error)
        );
    }
}

/**
 * Determines child work item types for a given parent type using category rules.
 * Resolves `bugsBehavior` via backlog configuration when necessary.
 * @param workItemType Parent work item type.
 * @param bugsBehavior Optional override for bug behavior.
 * @returns Array of child type names or null.
 */
async function getChildTypes(
    workItemType: string,
    bugsBehavior?: BugsBehavior
): Promise<string[] | null> {
    if (!webContext || !witClient) {
        await initialize();
    }

    WriteLog("Resolving child types for " + workItemType + "...");
    let categories: WorkItemTypeCategory[];
    try {
        categories = await fetchWorkItemTypeCategoriesViaRest();
    } catch (restError) {
        WriteLog(
            "Categories REST fetch failed: " +
            formatError(restError) +
            "; no client fallback (REST-only)."
        );
        return null;
    }
    const category = findWorkTypeCategory(categories, workItemType);
    if (!category) {
        WriteLog("No work item type category found for " + workItemType);
        return null;
    }
    try {
        WriteLog(
            "Found work item type category for " +
            workItemType +
            ": " +
            (category.name || category.referenceName || "unknown") +
            " (" +
            (category.referenceName || "unknown") +
            "); types: " +
            (category.workItemTypes || [])
                .map((t) => t.name || "unknown")
                .join(", ")
        );
    } catch { }

    let bugMode: BugsBehavior = BugsBehavior.Off;
    if (typeof bugsBehavior !== "undefined") {
        bugMode = bugsBehavior;
    } else {
        const needsBugBehavior =
            category.referenceName === "Microsoft.FeatureCategory" ||
            category.referenceName === "Microsoft.RequirementCategory";
        if (needsBugBehavior) {
            try {
                const teamContext = getTeamContext();
                const derived = await fetchBacklogConfigurationViaRest(teamContext);
                bugMode = (derived as any)?.bugsBehavior ?? BugsBehavior.Off;
                WriteLog("Resolved bug behavior via REST: " + bugMode);
            } catch (e) {
                WriteLog(
                    "Bug behavior lookup failed; defaulting to Off: " +
                    formatError(e)
                );
                bugMode = BugsBehavior.Off;
            }
        }
    }

    if (category.referenceName === "Microsoft.EpicCategory") {
        let featureCategory: WorkItemTypeCategory;
        try {
            featureCategory = await fetchWorkItemTypeCategoryViaRest("Microsoft.FeatureCategory");
        } catch (error) {
            WriteLog("Feature category REST fetch failed: " + formatError(error));
            return null;
        }
        return featureCategory.workItemTypes.map((item) => item.name);
    }

    const requests: Promise<WorkItemTypeCategory>[] = [];

    if (category.referenceName === "Microsoft.FeatureCategory") {
        requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.RequirementCategory"));
        if (bugMode === BugsBehavior.AsRequirements) {
            requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.BugCategory"));
        }
    } else if (category.referenceName === "Microsoft.RequirementCategory") {
        requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.TaskCategory"));
        if (bugMode === BugsBehavior.AsTasks) {
            requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.BugCategory"));
        }
    } else if (category.referenceName === "Microsoft.TaskCategory") {
        requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.TaskCategory"));
    } else if (category.referenceName === "Microsoft.BugCategory") {
        requests.push(fetchWorkItemTypeCategoryViaRest("Microsoft.TaskCategory"));
    }

    if (!requests.length) {
        WriteLog("No downstream categories applicable for " + workItemType);
        return null;
    }

    const responses = await Promise.all(requests);

    const result: string[] = [];
    responses.forEach((cat) => {
        cat.workItemTypes.forEach((type) => result.push(type.name));
    });
    WriteLog("Child type response: " + result.join(", "));
    return result;
}

/**
 * Normalizes category payload to a stable shape.
 * @param payload Raw category payload.
 * @returns Normalized `WorkItemTypeCategory`.
 */
function normalizeCategoryPayload(payload: any): WorkItemTypeCategory {
    const types = (payload?.workItemTypes || []).map((t: any) => ({ name: t?.name, referenceName: t?.referenceName }));
    const result: any = {
        name: payload?.name,
        referenceName: payload?.referenceName,
        workItemTypes: types,
    };
    return result as unknown as WorkItemTypeCategory;
}

/**
 * Checks whether a template applies based on filters in its description (JSON or bracket list).
 * @param currentWorkItem Parent work item fields.
 * @param taskTemplate Template payload.
 * @returns True if template is applicable.
 */
function isValidTemplateWIT(
    currentWorkItem: WorkItemFields,
    taskTemplate: WorkItemTemplate
): boolean {
    const extracted = extractJSON(
        taskTemplate.description,
        getTemplateName(taskTemplate)
    );
    const jsonFilters = extracted && extracted[0];

    if (jsonFilters && typeof jsonFilters === "object" && Array.isArray(jsonFilters.applywhen)) {
        return jsonFilters.applywhen.some((el: Record<string, any>) => {
            try {
                return (
                    matchField("System.BoardColumn", currentWorkItem, el) &&
                    matchField("System.BoardLane", currentWorkItem, el) &&
                    matchField("System.State", currentWorkItem, el) &&
                    matchField("System.Tags", currentWorkItem, el) &&
                    matchField("System.Title", currentWorkItem, el) &&
                    matchField("System.AreaPath", currentWorkItem, el) &&
                    matchField("System.IterationPath", currentWorkItem, el) &&
                    matchField("System.WorkItemType", currentWorkItem, el)
                );
            } catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                WriteLog("Skipping malformed filter rule: " + err);
                return false;
            }
        });
    }

    const filters =
        taskTemplate.description &&
        taskTemplate.description.match(/[[^\]]+(?=])/g);
    if (filters) {
        for (let i = 0; i < filters.length; i++) {
            const found = filters[i]
                .split(",")
                .find(
                    (f) =>
                        f.trim().toLowerCase() ===
                        currentWorkItem["System.WorkItemType"].toLowerCase()
                );
            if (found) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Title validation hook; currently accepts all templates.
 * @param _currentWorkItem Parent work item fields.
 * @param _taskTemplate Template payload.
 * @returns True always.
 */
function isValidTemplateTitle(
    _currentWorkItem: WorkItemFields,
    _taskTemplate: WorkItemTemplate
): boolean {
    return true;
}
// #endregion TemplatesAndProcessing

// =============================================================================
// Section: Other (Dialogs, Registration)
// =============================================================================
// #region Other

/**
 * Displays a message dialog in Azure DevOps host.
 * @param message Message to show.
 */
async function showDialog(message: string): Promise<void> {
    const dialogService = await SDK.getService<IHostPageLayoutService>(
        CommonServiceIds.HostPageLayoutService
    );
    dialogService.openMessageDialog(message, {
        title: "Create Child Tasks",
        showCancel: false,
    });
}

SDK.register("create-child-task-work-item-button", () => ({
    createTasks: (context: ActionContext) => run(context),
    execute: (context: ActionContext) => run(context),
}));
WriteLog("SDK.register completed for create-child-task-work-item-button.");
// #endregion Other
