define(["q"], function (Q) {
    "use strict";

    // ===== REST Helpers =====
    
    /**
     * Get Azure DevOps web context essentials (base URI and project name).
     * @returns {{base: string, projectName: string}}
     */
    function getContextInfo() {
        var wc = VSS.getWebContext();
        var base = wc && wc.collection && wc.collection.uri ? wc.collection.uri : (wc.account && wc.account.uri ? wc.account.uri : '');
        var projectName = wc && wc.project && wc.project.name ? wc.project.name : '';
        return { base: base, projectName: projectName };
    }

    /**
     * Resolve the current access token string from VSS.
     * @returns {Promise<string>} Bearer token string.
     */
    function getAccessTokenString() {
        return Q.when(VSS.getAccessToken()).then(function (tokenObj) {
            return (tokenObj && tokenObj.token) ? tokenObj.token : tokenObj;
        });
    }
    
    /**
     * Perform an authenticated REST GET against Azure DevOps.
     * Suppresses FedAuth redirects for iframe contexts.
     * @param {string} url - Full request URL.
     * @param {string} token - Bearer access token from VSS.getAccessToken().
     * @returns {Promise<object>} Parsed JSON payload (empty object on parse error).
     */
    function getJson(url, token) {
        return Q.Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, true);
                xhr.setRequestHeader('Authorization', 'Bearer ' + token);
                xhr.setRequestHeader('Accept', 'application/json');
                // Suppress FedAuth redirects inside iframe contexts for REST calls
                xhr.setRequestHeader('X-TFS-FedAuthRedirect', 'Suppress');
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            try {
                                var payload = JSON.parse(xhr.responseText);
                                resolve(payload);
                            } catch (e) {
                                resolve({});
                            }
                        } else {
                            var msg = xhr.responseText || (xhr.status + ' ' + xhr.statusText);
                            reject(new Error(msg));
                        }
                    }
                };
                xhr.send();
            } catch (e) { reject(e); }
        });
    }

    /**
     * Send a JSON Patch document via REST to Azure DevOps.
     * @param {string} url - Endpoint URL.
     * @param {string} token - Bearer access token from VSS.getAccessToken().
     * @param {Array<object>|object} patchOps - JSON Patch operations array or single operation object.
     * @returns {Promise<object>} Parsed JSON payload (empty object on parse error).
     */
    function patchJson(url, token, patchOps) {
        return Q.Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('PATCH', url, true);
                xhr.setRequestHeader('Authorization', 'Bearer ' + token);
                xhr.setRequestHeader('Accept', 'application/json');
                xhr.setRequestHeader('Content-Type', 'application/json-patch+json');
                // Suppress FedAuth redirects inside iframe contexts for REST calls
                xhr.setRequestHeader('X-TFS-FedAuthRedirect', 'Suppress');
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            try {
                                var payload = JSON.parse(xhr.responseText);
                                resolve(payload);
                            } catch (e) {
                                resolve({});
                            }
                        } else {
                            var msg = xhr.responseText || (xhr.status + ' ' + xhr.statusText);
                            reject(new Error(msg));
                        }
                    }
                };
                xhr.send(JSON.stringify(patchOps));
            } catch (e) { reject(e); }
        });
    }

    // ===== REST Functions =====
    
    /**
     * Create a child work item and link it to the parent.
     * Note: expects the caller to supply the already-built JSON patch for the child (newWorkItem).
     * @param {Object} currentWorkItem - Parent work item fields map.
     * @param {Object} taskTemplate - Template definition with fields and metadata.
     * @param {Array<object>} newWorkItem - JSON Patch operations for work item creation.
     * @returns {Promise<void>} Resolves after create and link operations complete.
     */
    function createChildWorkItem(currentWorkItem, taskTemplate, newWorkItem) {
        var ctx = getContextInfo();
        var workItemId = currentWorkItem['System.Id'];
        var createUrl = ctx.base + encodeURIComponent(ctx.projectName) + '/_apis/wit/workitems/$' + encodeURIComponent(taskTemplate.workItemTypeName) + '?api-version=6.0';
        var parentUpdateUrl = ctx.base + encodeURIComponent(ctx.projectName) + '/_apis/wit/workitems/' + workItemId + '?api-version=6.0';

        return getAccessTokenString().then(function (token) {
            return patchJson(createUrl, token, newWorkItem).then(function (created) {
                var document = [{
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: 'System.LinkTypes.Hierarchy-Forward',
                        url: created && created.url ? created.url : (ctx.base + '_apis/wit/workItems/' + (created && created.id ? created.id : '')),
                        attributes: { isLocked: false }
                    }
                }];
                // Do not reload here; defer UI refresh until the entire batch completes
                return patchJson(parentUpdateUrl, token, document).then(function () {
                    return Q.when();
                });
            });
        });
    }

    /**
     * Fetch a work item via REST with optional field filtering for performance.
     * @param {number} workItemId
     * @param {string[]} fields Optional list of field refs to include.
     * @returns {Promise<object>} Work item JSON (id, fields, etc.).
     */
    function getWorkItem(workItemId, fields) {
        var ctx = getContextInfo();
        var url = ctx.base + encodeURIComponent(ctx.projectName) + '/_apis/wit/workitems/' + encodeURIComponent(workItemId) + '?api-version=6.0';
        if (Array.isArray(fields) && fields.length > 0) {
            // Azure DevOps expects a single comma-separated 'fields' parameter
            url += '&fields=' + encodeURIComponent(fields.join(','));
        }
        return getAccessTokenString().then(function (token) {
            return getJson(url, token);
        });
    }

    /**
     * Fetch team settings via REST for the current project/team.
     * Augments the payload with `defaultIteration.path` derived from team iterations for compatibility.
     * @returns {Promise<object>} Team settings object (bugsBehavior, backlogIteration, defaultIteration with path).
     */
    function getTeamSettings() {
        var ctx = getContextInfo();
        var wc = VSS.getWebContext();
        var teamIdOrName = (wc && wc.team && (wc.team.id || wc.team.name)) || '';
        var settingsUrl = ctx.base + encodeURIComponent(ctx.projectName) + '/' + encodeURIComponent(teamIdOrName) + '/_apis/work/teamsettings?api-version=6.0';
        var iterationsUrl = ctx.base + encodeURIComponent(ctx.projectName) + '/' + encodeURIComponent(teamIdOrName) + '/_apis/work/teamsettings/iterations?api-version=6.0';

        return getAccessTokenString().then(function (token) {
            return getJson(settingsUrl, token).then(function (settings) {
                // Derive default iteration path for compatibility with existing logic
                return getJson(iterationsUrl, token).then(function (iters) {
                    try {
                        var list = (iters && iters.value) ? iters.value : [];
                        var defId = settings && settings.defaultIteration && settings.defaultIteration.id;
                        var match = null;
                        for (var i = 0; i < list.length; i++) {
                            if (list[i] && list[i].id === defId) { match = list[i]; break; }
                        }
                        if (match && match.path) {
                            var fullPath = match.path; // e.g., 'ProjectName\\Iteration\\Sprint 1'
                            var projectName = (wc && wc.project && wc.project.name) ? wc.project.name : '';
                            var backlogName = (settings && settings.backlogIteration && settings.backlogIteration.name) ? settings.backlogIteration.name : projectName;
                            var relative = fullPath;
                            // Remove leading project name
                            if (projectName && relative.indexOf(projectName) === 0) {
                                relative = relative.substring(projectName.length);
                            }
                            // Remove leading backlog name if present
                            if (backlogName && relative.indexOf(backlogName) === 0) {
                                relative = relative.substring(backlogName.length);
                            }
                            // Ensure leading backslash
                            relative = relative.replace(/^\\+/, '');
                            if (relative && relative.charAt(0) !== '\\') {
                                relative = '\\' + relative;
                            }
                            settings.defaultIteration = settings.defaultIteration || {};
                            settings.defaultIteration.path = relative;
                        }
                    } catch (e) {
                        // If derivation fails, leave path undefined without throwing
                    }
                    return settings;
                });
            });
        });
    }

    return {
        patchJson: patchJson,
        getJson: getJson,
        createChildWorkItem: createChildWorkItem,
        getWorkItem: getWorkItem,
        getTeamSettings: getTeamSettings
    };
});
