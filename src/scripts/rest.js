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
     * @param {*} service - Work Item Form Service instance or null.
     * @param {Object} currentWorkItem - Parent work item fields map.
     * @param {Object} taskTemplate - Template definition with fields and metadata.
     * @param {Object} teamSettings - Team settings (included for parity; not used in this function).
     * @param {Array<object>} newWorkItem - JSON Patch operations for work item creation.
     * @returns {Promise<void>} Resolves after create and link operations complete.
     */
    function createChildWorkItem(service, currentWorkItem, taskTemplate, teamSettings, newWorkItem) {
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

    return {
        patchJson: patchJson,
        getJson: getJson,
        createChildWorkItem: createChildWorkItem,
        getWorkItem: getWorkItem
    };
});
