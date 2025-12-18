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
import { WorkRestClient } from "azure-devops-extension-api/Work/WorkClient";
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

const CLIENT_TIMEOUT_MS = 8000;

SDK.init({ applyTheme: true });
WriteLog("Toolbar bundle loaded; waiting for SDK context.");

let initPromise: Promise<void> | null = null;
let webContext: ReturnType<typeof SDK.getWebContext> | null = null;
let witClient: WorkItemTrackingRestClient | null = null;
let workClient: WorkRestClient | null = null;
let coreClient: CoreRestClient | null = null;
let currentUser: IUserContext | null = null;
let cachedTeamContext: TeamContext | null = null;
let accessTokenPromise: Promise<string> | null = null;
let cachedCollectionUri: string | null = null;

/**
 * Initializes the Azure DevOps Extension SDK context, caches REST clients and user context,
 * resolves collection URI, runs diagnostics, and resolves team context. Safe to call multiple times.
 * @returns Promise that resolves when initialization completes.
 */
function ensureInitialized(): Promise<void> {
    if (!initPromise) {
        WriteLog("Initializing Azure DevOps SDK context...");
        initPromise = SDK.ready().then(async () => {
            WriteLog("SDK.ready resolved; caching clients and context.");
            webContext = SDK.getWebContext();
            primeCollectionUriFromContext(SDK.getConfiguration());
            currentUser = SDK.getUser();
            witClient = getClient(WorkItemTrackingRestClient);
            workClient = getClient(WorkRestClient);
            coreClient = getClient(CoreRestClient);
            SDK.notifyLoadSucceeded();
            WriteLog("notifyLoadSucceeded dispatched; extension idle.");
            try {
                const cid = SDK.getContributionId && SDK.getContributionId();
                if (cid) {
                    WriteLog("Contribution id: " + cid);
                }
            } catch { }
            await logNetworkDiagnostics();
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
 * Logs network and host diagnostics including collection URI, public access point,
 * origin comparison, and probes `_apis/connectionData` to confirm basic connectivity.
 * Intended for troubleshooting; not required for core functionality.
 * @returns Promise that resolves after logging diagnostics.
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
 * Returns the cached `TeamContext` once resolved. Throws if not yet available.
 * @returns TeamContext for current project/team.
 */
function getTeamContext(): TeamContext {
    if (!cachedTeamContext) {
        throw new Error("Team context not available yet");
    }
    return cachedTeamContext;
}

/**
 * Resolves and caches the `TeamContext` from `webContext`, falling back to Core API to fetch
 * the project's default team when team info is missing.
 * @returns Promise that resolves after caching the team context.
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
 * Entry point for the toolbar command. Ensures initialization and dispatches to create flow
 * based on provided `ActionContext`.
 * @param context Action context containing work item ids or single id.
 * @returns Promise that resolves when command execution completes.
 */
async function run(context: ActionContext): Promise<void> {
    WriteLog(
        "Toolbar command invoked with context: " +
        JSON.stringify(context ?? {}, null, 2)
    );
    primeCollectionUriFromContext(context);
    try {
        await ensureInitialized();
        await create(context);
    } catch (error) {
        WriteLog("Unhandled error: " + formatError(error));
    }
}

/**
 * Determines whether the command is running on a form (active work item) or grid (list of ids)
 * and triggers the appropriate task creation workflow.
 * @param context Action context with optional work item ids.
 * @returns Promise resolved when processing finishes.
 */
async function create(context: ActionContext): Promise<void> {
    WriteLog("Determining execution surface (form vs grid)...");
    const service = await SDK.getService<IWorkItemFormService>(
        WorkItemTrackingServiceIds.WorkItemFormService
    );
    const hasActiveWorkItem = await service.hasActiveWorkItem();
    WriteLog("Has active work item: " + hasActiveWorkItem);

    if (hasActiveWorkItem) {
        WriteLog("Active work item detected; running form workflow");
        await addTasksOnForm(service);
        return;
    }

    const ids = (context && context.workItemIds && context.workItemIds.length)
        ? context.workItemIds
        : context && context.id
            ? [context.id]
            : [];

    WriteLog("Grid context work item ids: " + JSON.stringify(ids));

    if (!ids.length) {
        WriteLog("No work item context provided");
        return;
    }

    for (const workItemId of ids) {
        await addTasksOnGrid(workItemId);
    }
}

/**
 * Adds tasks using the form service when a single active work item is open.
 * @param service Form service to access the active work item and link relations.
 * @returns Promise that resolves after tasks are added.
 */
async function addTasksOnForm(service: IWorkItemFormService): Promise<void> {
    const workItemId = await service.getId();
    WriteLog("Form work item id: " + workItemId);
    if (typeof workItemId === "number") {
        await addTasks(workItemId, service);
    }
}

/**
 * Adds tasks for a work item in grid context (no form service available).
 * @param workItemId The id of the parent work item.
 * @returns Promise that resolves when tasks are added.
 */
function addTasksOnGrid(workItemId: number): Promise<void> {
    return addTasks(workItemId, null);
}

/**
 * Main workflow to add child tasks to a given work item: fetches work item data,
 * optionally resolves team settings for bug behavior, determines child types,
 * fetches templates, and creates child items.
 * @param workItemId Parent work item id.
 * @param service Form service when available; null for grid.
 * @returns Promise resolved after child creation flow completes.
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
    if (!webContext || !witClient || !workClient) {
        WriteLog("Clients/context missing; triggering ensureInitialized().");
        await ensureInitialized();
    }

    const teamContext = getTeamContext();
    const workItem = await getWorkItemData(workItemId);
    const currentWorkItem: WorkItemFields = {
        ...(workItem.fields || {}),
        "System.Id": workItemId,
    };

    // Simple Mode removed: always use full template flow

    const workItemType = currentWorkItem["System.WorkItemType"];
    if (!workItemType) {
        WriteLog("Unable to determine work item type for id " + workItemId);
        return;
    }
    WriteLog("Work item type: " + workItemType);

    // Only fetch team settings when needed (primarily for Bug behavior)
    let teamSettings: TeamSetting = { bugsBehavior: BugsBehavior.Off } as unknown as TeamSetting;
    const needsBugBehavior = /^(Bug|Issue)$/i.test(String(workItemType));
    if (needsBugBehavior) {
        try {
            teamSettings = await getTeamSettingsData(teamContext);
            WriteLog("Team settings resolved; bugsBehavior=" + (teamSettings as any)?.bugsBehavior);
        } catch (e) {
            WriteLog(
                "Team settings unavailable; proceeding with default bugsBehavior=Off: " +
                formatError(e)
            );
            teamSettings = { bugsBehavior: BugsBehavior.Off } as unknown as TeamSetting;
        }
    } else {
        WriteLog("Skipping team settings fetch (not needed for type " + workItemType + ")");
    }

    const childTypes = await getChildTypes(workItemType, teamSettings.bugsBehavior);

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

// Simple Mode test-creation helper removed

/**
 * Retrieves a work item by id, preferring REST and falling back to the client if needed.
 * Logs basic info upon success.
 * @param workItemId The work item id to fetch.
 * @returns The work item payload.
 */
async function getWorkItemData(workItemId: number): Promise<any> {
    if (!witClient) {
        await ensureInitialized();
    }
    // Prefer REST first; client calls have been timing out in some hosts
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
    try {
        WriteLog("Fetching work item " + workItemId + " via client fallback...");
        const workItem = await withTimeout(
            witClient!.getWorkItem(workItemId),
            "getWorkItem"
        );
        WriteLog("getWorkItem (client) resolved for id " + workItemId);
        logWorkItemBasicInfo("CLIENT", workItem);
        return workItem;
    } catch (error) {
        WriteLog(
            "getWorkItem via client also failed or timed out: " + formatError(error)
        );
        throw error;
    }
}

/**
 * Retrieves team settings for the given team context, first deriving bugs behavior from
 * backlog configuration, then using teamsettings REST routes, and finally the client fallback.
 * @param teamContext The team context containing project/team identifiers.
 * @returns The resolved `TeamSetting` including `bugsBehavior`.
 */
async function getTeamSettingsData(teamContext: TeamContext): Promise<TeamSetting> {
    if (!workClient) {
        await ensureInitialized();
    }
    // Prefer REST first; client calls have been unreliable in some hosts
    try {
        WriteLog(
            "Fetching team settings via REST (preferred) for team " +
            (teamContext.teamId || teamContext.team)
        );
        // First try backlog configuration (more widely available) to derive bugsBehavior
        try {
            const derived = await fetchBacklogConfigurationViaRest(teamContext);
            WriteLog(
                "Backlog configuration fetched; derived bugsBehavior=" +
                (derived as any)?.bugsBehavior
            );
            return derived;
        } catch (bcErr) {
            WriteLog(
                "Backlog configuration fetch failed: " +
                formatError(bcErr) +
                "; falling back to teamsettings routes"
            );
        }
        return await fetchTeamSettingsViaRest(teamContext);
    } catch (restError) {
        WriteLog(
            "Team settings REST fetch failed: " +
            formatError(restError) +
            "; attempting client call as fallback"
        );
    }
    try {
        WriteLog(
            "Fetching team settings via client fallback for team " +
            (teamContext.teamId || teamContext.team)
        );
        const settings = await withTimeout(
            workClient!.getTeamSettings(teamContext),
            "getTeamSettings"
        );
        WriteLog(
            "getTeamSettings (client) resolved for team " +
            (teamContext.teamId || teamContext.team)
        );
        return settings;
    } catch (error) {
        WriteLog(
            "Team settings via client also failed or timed out: " +
            formatError(error) +
            "; proceeding with default settings"
        );
        return { bugsBehavior: BugsBehavior.Off } as unknown as TeamSetting;
    }
}

/**
 * REST-only helper to derive `bugsBehavior` from backlog configuration endpoints.
 * Tries multiple documented routing variants using project/team identifiers.
 * @param teamContext The team context with project and team.
 * @returns A TeamSetting object with normalized `bugsBehavior`.
 */
async function fetchBacklogConfigurationViaRest(
    teamContext: TeamContext
): Promise<TeamSetting> {
    if (!webContext) {
        throw new Error("Web context not initialized");
    }
    const base = getCollectionUri();
    const projectId = webContext.project.id;
    const projectName = webContext.project.name;
    const teamId = teamContext.teamId || webContext.team?.id;
    const teamName = teamContext.team || webContext.team?.name;

    if (!projectId || (!teamId && !teamName)) {
        throw new Error("Missing project or team identifiers for backlog configuration");
    }

    const candidates: string[] = [];
    // Path segment variants
    if (projectId && teamId) {
        candidates.push(
            base +
            encodeURIComponent(projectId) +
            "/" + encodeURIComponent(teamId) +
            "/_apis/work/backlogconfiguration?api-version=7.1-preview.2"
        );
    }
    if (projectName && teamName) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/" + encodeURIComponent(teamName) +
            "/_apis/work/backlogconfiguration?api-version=7.1-preview.2"
        );
    }
    if (projectId && teamName) {
        candidates.push(
            base +
            encodeURIComponent(projectId) +
            "/" + encodeURIComponent(teamName) +
            "/_apis/work/backlogconfiguration?api-version=7.1-preview.2"
        );
    }
    if (projectName && teamId) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/" + encodeURIComponent(teamId) +
            "/_apis/work/backlogconfiguration?api-version=7.1-preview.2"
        );
    }
    // Query-param variants
    candidates.push(
        base +
        "_apis/work/backlogconfiguration?project=" + encodeURIComponent(projectId) +
        "&team=" + encodeURIComponent(teamId || teamName!) +
        "&api-version=7.1-preview.2"
    );
    if (projectName) {
        candidates.push(
            base +
            "_apis/work/backlogconfiguration?project=" + encodeURIComponent(projectName) +
            "&team=" + encodeURIComponent(teamName || teamId!) +
            "&api-version=7.1-preview.2"
        );
    }
    candidates.push(
        base +
        encodeURIComponent(projectId) +
        "/_apis/work/backlogconfiguration?team=" + encodeURIComponent(teamId || teamName!) +
        "&api-version=7.1-preview.2"
    );
    if (projectName) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/_apis/work/backlogconfiguration?team=" + encodeURIComponent(teamId || teamName!) +
            "&api-version=7.1-preview.2"
        );
    }

    let lastError: any = null;
    for (const url of candidates) {
        WriteLog("Fetching backlog configuration via REST fallback: " + url);
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
            lastError = err;
            WriteLog("Backlog configuration attempt failed: " + formatError(err));
        }
    }
    throw lastError || new Error("All backlog configuration REST attempts failed");
}

/**
 * Wraps a promise with a timeout. Rejects with a descriptive error if the timeout elapses.
 * @typeParam T Return type of the wrapped promise.
 * @param promise The promise to wrap.
 * @param label A label used in the timeout error message.
 * @param timeoutMs Timeout in milliseconds.
 * @returns A promise that resolves/rejects with the original result or a timeout error.
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

/**
 * Logs a concise summary of a work item (id, type, title, state, assigned, area, iteration).
 * @param source A label indicating the data source (REST/CLIENT).
 * @param workItem The work item payload.
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
 * Fetches a work item via REST with `?$expand=all` for field completeness.
 * @param workItemId The id of the work item to fetch.
 * @returns Work item JSON payload.
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
 * Attempts team settings retrieval via documented REST routes with a set of routing variants.
 * @param teamContext The team context to use for routing.
 * @returns The team settings payload if a route succeeds.
 */
async function fetchTeamSettingsViaRest(
    teamContext: TeamContext
): Promise<TeamSetting> {
    if (!webContext) {
        throw new Error("Web context not initialized");
    }
    const base = getCollectionUri();
    const projectId = webContext.project.id;
    const projectName = webContext.project.name;
    const teamId = teamContext.teamId || webContext.team?.id;
    const teamName = teamContext.team || webContext.team?.name;

    if (!projectId || (!teamId && !teamName)) {
        throw new Error("Missing project or team identifiers for REST fallback");
    }

    const candidates: string[] = [];

    // Prefer documented path-segment routes first
    // A) projectId + teamId
    if (projectId && teamId) {
        candidates.push(
            base +
            encodeURIComponent(projectId) +
            "/" + encodeURIComponent(teamId) +
            "/_apis/work/teamsettings?api-version=7.1-preview.2"
        );
    }
    // B) projectName + teamName
    if (projectName && teamName) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/" + encodeURIComponent(teamName) +
            "/_apis/work/teamsettings?api-version=7.1-preview.2"
        );
    }
    // C) projectId + teamName (some hosts accept name in segment)
    if (projectId && teamName) {
        candidates.push(
            base +
            encodeURIComponent(projectId) +
            "/" + encodeURIComponent(teamName) +
            "/_apis/work/teamsettings?api-version=7.1-preview.2"
        );
    }
    // D) projectName + teamId
    if (projectName && teamId) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/" + encodeURIComponent(teamId) +
            "/_apis/work/teamsettings?api-version=7.1-preview.2"
        );
    }

    // E) Query-param variants (try both id and name)
    candidates.push(
        base +
        "_apis/work/teamsettings?project=" + encodeURIComponent(projectId) +
        "&team=" + encodeURIComponent(teamId || teamName!) +
        "&api-version=7.1-preview.2"
    );
    if (projectName) {
        candidates.push(
            base +
            "_apis/work/teamsettings?project=" + encodeURIComponent(projectName) +
            "&team=" + encodeURIComponent(teamName || teamId!) +
            "&api-version=7.1-preview.2"
        );
    }
    candidates.push(
        base +
        encodeURIComponent(projectId) +
        "/_apis/work/teamsettings?team=" + encodeURIComponent(teamId || teamName!) +
        "&api-version=7.1-preview.2"
    );
    if (projectName) {
        candidates.push(
            base +
            encodeURIComponent(projectName) +
            "/_apis/work/teamsettings?team=" + encodeURIComponent(teamId || teamName!) +
            "&api-version=7.1-preview.2"
        );
    }

    let lastError: any = null;
    for (const url of candidates) {
        WriteLog("Fetching team settings via REST fallback: " + url);
        try {
            return await adoFetch<TeamSetting>(url);
        } catch (err) {
            lastError = err;
            WriteLog("Team settings attempt failed: " + formatError(err));
        }
    }

    throw lastError || new Error("All team settings REST attempts failed");
}

/**
 * Performs an authenticated fetch with SDK access token, setting appropriate headers,
 * handling same-origin vs CORS, and throwing on non-OK responses.
 * @typeParam T Expected JSON response type.
 * @param url The request URL.
 * @param init Optional fetch options (method, headers, body).
 * @returns Parsed JSON response of type T.
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
 * Retrieves and caches the Azure DevOps access token via SDK. Subsequent calls reuse the promise.
 * @returns The access token string.
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
 * Resolves the collection URI from various SDK contexts, falling back to location-derived heuristics.
 * @returns The collection base URI with trailing slash.
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
 * Attempts to prime `cachedCollectionUri` from a provided context object, checking multiple properties.
 * @param context SDK configuration or page context object.
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
 * Extracts a normalized contextData object from various SDK context shapes.
 * @param context Any SDK context-like object.
 * @returns Normalized context data or null.
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
 * Attempts to construct a URI from host-like objects (scheme, authority, relative paths).
 * @param hostLike An object containing host properties.
 * @returns A URI string or null if insufficient data.
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
 * Constructs an absolute URI from a relative path using `window.location.origin`.
 * @param relativeUri Relative path string.
 * @returns Absolute URI string or null.
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
 * Derives a collection-like base URI from `window.location` by removing `_` control segments.
 * @returns Derived base URI or null if not available.
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
 * Ensures the provided string ends with a trailing slash.
 * @param value The input string.
 * @returns The string with a trailing slash.
 */
function ensureTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : value + "/";
}

/**
 * Returns the current project id and name from `webContext`.
 * @returns An object with `id` and `name`.
 */
function getProjectIds(): { id: string; name: string } {
    if (!webContext) {
        throw new Error("Web context not initialized");
    }
    return { id: webContext.project.id, name: webContext.project.name };
}

/**
 * Fetches all work item type categories for the current project via REST.
 * @returns Array of normalized `WorkItemTypeCategory` entries.
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
 * Fetches a specific work item type category by its reference name via REST.
 * @param referenceName Category reference name (e.g., "Microsoft.TaskCategory").
 * @returns Normalized `WorkItemTypeCategory`.
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
 * Normalizes category payloads into `WorkItemTypeCategory` shape with `workItemTypes` entries.
 * @param payload Raw REST payload.
 * @returns Normalized category object.
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
 * Fetches team work item templates for the given work item type names (filtered one type per call).
 * @param workItemTypes Array of work item type names to filter templates (e.g., ["Task"]).
 * @returns Array of `WorkItemTemplateReference` across requested types.
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
 * Fetches a single template detail (`WorkItemTemplate`) by id for the current project/team.
 * @param id Template id.
 * @returns Full template payload including `fields`.
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
 * Creates a work item via REST using JSON Patch operations.
 * @param workItemTypeName The work item type name (e.g., "Task").
 * @param document JSON Patch array of operations to set fields.
 * @returns Created work item payload.
 */
async function restCreateWorkItem(
    workItemTypeName: string,
    document: JsonPatch[]
): Promise<any> {
    const base = getCollectionUri();
    const { id, name } = getProjectIds();
    const candidates = [
        base +
        encodeURIComponent(id) +
        "/_apis/wit/workitems/$" +
        encodeURIComponent(workItemTypeName) +
        "?api-version=7.1",
        base +
        encodeURIComponent(name) +
        "/_apis/wit/workitems/$" +
        encodeURIComponent(workItemTypeName) +
        "?api-version=7.1",
    ];
    const body = JSON.stringify(document);
    const init: RequestInit = {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json-patch+json",
            Accept: "application/json",
        },
        body,
    };
    let lastError: any = null;
    for (const url of candidates) {
        WriteLog("Creating work item via REST: " + url);
        try {
            return await adoFetch<any>(url, init);
        } catch (err) {
            lastError = err;
            WriteLog("REST create attempt failed: " + formatError(err));
        }
    }
    throw lastError || new Error("All REST create attempts failed");
}

/**
 * Updates a work item's relations (e.g., adding hierarchy links) via REST with JSON Patch.
 * @param workItemId The id of the work item to update.
 * @param document JSON Patch payload of relation operations.
 * @returns Updated work item payload.
 */
async function restUpdateWorkItemLinks(
    workItemId: number,
    document: JsonPatch[]
): Promise<any> {
    const base = getCollectionUri();
    const { id, name } = getProjectIds();
    const candidates = [
        base + encodeURIComponent(id) + "/_apis/wit/workitems/" + workItemId + "?api-version=7.1",
        base + encodeURIComponent(name) + "/_apis/wit/workitems/" + workItemId + "?api-version=7.1",
    ];
    const body = JSON.stringify(document);
    const init: RequestInit = {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json-patch+json",
            Accept: "application/json",
        },
        body,
    };
    let lastError: any = null;
    for (const url of candidates) {
        WriteLog("Updating work item links via REST fallback: " + url);
        try {
            return await adoFetch<any>(url, init);
        } catch (err) {
            lastError = err;
            WriteLog("REST update attempt failed: " + formatError(err));
        }
    }
    throw lastError || new Error("All REST update attempts failed");
}

/**
 * Creates a child work item from a given template after validation checks.
 * @param service Form service for linking when available; null in grid.
 * @param currentWorkItem Parent work item fields.
 * @param template Template reference to instantiate.
 * @param teamSettings Team settings (bugs behavior).
 * @returns Promise resolved after creation attempt.
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
 * Retrieves all template references for the given child work item types via REST.
 * @param workItemTypes Child type names.
 * @returns Array of `WorkItemTemplateReference`.
 */
async function getTemplates(
    workItemTypes: string[]
): Promise<WorkItemTemplateReference[]> {
    if (!webContext || !witClient) {
        WriteLog("getTemplates missing context/client; reinitializing.");
        await ensureInitialized();
    }
    // REST-only: if REST fails, log and return no templates
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

// Removed legacy fast template fallback and inline defaults to enforce REST-only behavior

/**
 * Retrieves full template details, using a cache when available.
 * @param id Template id.
 * @returns Full `WorkItemTemplate` payload.
 */
async function getTemplate(id: string): Promise<WorkItemTemplate> {
    if (!webContext) {
        await ensureInitialized();
    }
    WriteLog("Fetching template details via REST for id " + id);
    return fetchTemplateViaRest(id);
}

/**
 * Validates whether a template field key should be applied when creating a work item.
 * Filters tags and dynamic tokens like @me/@currentiteration.
 * @param taskTemplate Template payload being applied.
 * @param key Field path/key.
 * @returns True if valid for inclusion.
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
 * Replaces `{ParentField}` placeholders in a template field value with values from the current work item.
 * @param fieldValue The template field value possibly containing placeholders.
 * @param currentWorkItem Parent work item fields.
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
 * Builds a JSON Patch document from a template and parent fields, applying validations and substitutions.
 * @param currentWorkItem Parent work item fields.
 * @param taskTemplate Template payload with `fields`.
 * @param teamSettings Team settings for iteration/bug handling.
 * @returns JSON Patch array to create the child work item.
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
 * Creates a child work item from a template, links it to the parent, and handles form/grid flows.
 * @param service Form service when available; null for grid context.
 * @param currentWorkItem Parent work item fields.
 * @param taskTemplate Template payload for the child.
 * @param teamSettings Team settings used during creation.
 * @returns Promise that resolves after creation and linking.
 */
/**
 * Creates a child work item from a template, links it to the parent, and handles form/grid flows.
 * @param service Form service when available; null for grid context.
 * @param currentWorkItem Parent work item fields.
 * @param taskTemplate Template payload for the child.
 * @param teamSettings Team settings used during creation.
 * @returns Promise that resolves after creation and linking.
 */
async function createWorkItem(
    service: IWorkItemFormService | null,
    currentWorkItem: WorkItemFields,
    taskTemplate: WorkItemTemplate,
    teamSettings: TeamSetting
): Promise<void> {
    if (!webContext || !witClient) {
        WriteLog("createWorkItem missing context/client; reinitializing.");
        await ensureInitialized();
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
    // Prefer REST first per hybrid approach
    try {
        created = await restCreateWorkItem(taskTemplate.workItemTypeName, newWorkItem);
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
    // Success logging is consolidated in createChildFromTemplate

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
    // Prefer REST first for relation update
    try {
        await restUpdateWorkItemLinks(currentWorkItem["System.Id"], document);
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
 * Resolves child work item type names for a given parent type based on category rules
 * and team bugs behavior. Uses REST-only category endpoints.
 * @param workItemType Parent work item type name.
 * @param bugsBehavior Team bugs behavior mode.
 * @returns Array of child type names or null if none.
 */
async function getChildTypes(
    workItemType: string,
    bugsBehavior?: BugsBehavior
): Promise<string[] | null> {
    if (!webContext || !witClient) {
        await ensureInitialized();
    }

    WriteLog("Resolving child types for " + workItemType + "...");
    // Prefer REST first for queries
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

    const bugMode = bugsBehavior ?? BugsBehavior.Off;

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
 * Finds the category that contains the given work item type.
 * @param categories List of categories to search.
 * @param workItemType Work item type name to match.
 * @returns Matching category or undefined.
 */
function findWorkTypeCategory(categories: WorkItemTypeCategory[], workItemType: string): WorkItemTypeCategory | undefined {
    return categories.find((category) =>
        category.workItemTypes.some((type) => type.name === workItemType)
    );
}

/**
 * Sort comparator for templates by case-insensitive name ascending.
 * @param a First template.
 * @param b Second template.
 * @returns Negative/zero/positive per comparator contract.
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
 * Extracts a list of JSON objects from a string that may contain embedded JSON.
 * @param str Input string.
 * @param label Label for logging context.
 * @returns Array of parsed objects or null.
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
 * Matches a field on the current work item against a filter element rule.
 * Supports wildcard match for title, tag inclusion, arrays, and exact comparisons.
 * @param fieldName The field reference name to evaluate.
 * @param currentWorkItem Current parent work item fields.
 * @param filterElement A filter object containing expected values.
 * @returns True if the field satisfies the filter rule.
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
 * Tests a string against a simple wildcard rule where `*` matches any sequence (case-insensitive).
 * @param str Input string to test.
 * @param rule Wildcard rule string.
 * @returns True if the string matches the rule.
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
 * Determines whether a template is applicable to the current work item type
 * using JSON filters (applywhen) or legacy bracket filters in description.
 * @param currentWorkItem Current parent work item fields.
 * @param taskTemplate Template payload to evaluate.
 * @returns True if applicable; otherwise false.
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
        taskTemplate.description.match(/[^[\]]+(?=])/g);
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
 * Placeholder for title validation rules; currently always returns true.
 * @param _currentWorkItem Parent work item fields (unused).
 * @param _taskTemplate Template payload (unused).
 * @returns True.
 */
function isValidTemplateTitle(
    _currentWorkItem: WorkItemFields,
    _taskTemplate: WorkItemTemplate
): boolean {
    return true;
}

/**
 * Shows a message dialog via Host Page Layout service.
 * @param message Message text to display.
 * @returns Promise resolved after dialog is opened.
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

/**
 * Writes a namespaced log message to the console.
 * @param msg Message to log.
 */
function WriteLog(msg: string): void {
    console.log("Create Child Tasks: " + msg);
}

/**
 * Formats unknown error values into a readable string.
 * @param error Unknown error.
 * @returns Readable error string.
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
 * Returns a friendly template name or "unknown" when missing.
 * @param taskTemplate Template payload.
 * @returns Template name.
 */
function getTemplateName(taskTemplate: WorkItemTemplate): string {
    return taskTemplate && taskTemplate.name ? taskTemplate.name : "unknown";
}

SDK.register("create-child-task-work-item-button", () => ({
    createTasks: (context: ActionContext) => run(context),
    execute: (context: ActionContext) => run(context),
}));
WriteLog("SDK.register completed for create-child-task-work-item-button.");
