define(["q"], function (Q) {
    "use strict";

    // ===== REST Helpers =====
    function restJsonPatch(url, token, patchOps) {
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
                            try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve({}); }
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
     * Creates a child work item via REST, then updates the parent with a forward relation.
     * Note: expects the caller to supply the already-built JSON patch for the child (newWorkItem).
     */
    function createWorkItemViaRest(service, currentWorkItem, taskTemplate, teamSettings, newWorkItem) {
        var wc = VSS.getWebContext();
        var base = wc && wc.collection && wc.collection.uri ? wc.collection.uri : (wc.account && wc.account.uri ? wc.account.uri : '');
        var projectName = wc && wc.project && wc.project.name ? wc.project.name : '';
        var workItemId = currentWorkItem['System.Id'];

        var createUrl = base + encodeURIComponent(projectName) + '/_apis/wit/workitems/$' + encodeURIComponent(taskTemplate.workItemTypeName) + '?api-version=6.0';
        var parentUpdateUrl = base + encodeURIComponent(projectName) + '/_apis/wit/workitems/' + workItemId + '?api-version=6.0';

        return Q.when(VSS.getAccessToken()).then(function (tokenObj) {
            var token = (tokenObj && tokenObj.token) ? tokenObj.token : tokenObj; // VSS returns { token }
            return restJsonPatch(createUrl, token, newWorkItem).then(function (created) {
                var document = [{
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: 'System.LinkTypes.Hierarchy-Forward',
                        url: created && created.url ? created.url : (base + '_apis/wit/workItems/' + (created && created.id ? created.id : '')),
                        attributes: { isLocked: false }
                    }
                }];
                // Do not reload here; defer UI refresh until the entire batch completes
                return restJsonPatch(parentUpdateUrl, token, document).then(function () {
                    return Q.when();
                });
            });
        });
    }

    return {
        restJsonPatch: restJsonPatch,
        createWorkItemViaRest: createWorkItemViaRest
    };
});
