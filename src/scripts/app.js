define(["TFS/WorkItemTracking/Services", "TFS/WorkItemTracking/RestClient", "TFS/Work/RestClient", "q", "VSS/Controls", "VSS/Controls/StatusIndicator", "VSS/Controls/Dialogs"],
    function (_WorkItemServices, _WorkItemRestClient, workRestClient, Q, Controls, StatusIndicator, Dialogs) {

        var ctx = null;

        function getWorkItemFormService() {
            return _WorkItemServices.WorkItemFormService.getService();
        }

        function getTemplates(workItemTypes) {

            var requests = []
            var witClient = _WorkItemRestClient.getClient();

            workItemTypes.forEach(function (workItemType) {

                var request = witClient.getTemplates(ctx.project.id, ctx.team.id, workItemType);
                requests.push(request);
            }, this);

            return Q.all(requests)
                .then(function (templateTypes) {

                    var templates = [];
                    templateTypes.forEach(function (templateType) {
                        if (templateType.length > 0) {

                            templateType.forEach(function (element) {
                                templates.push(element)
                            }, this);
                        }
                    }, this);
                    return templates;
                });
        }

        function getTemplate(id) {
            var witClient = _WorkItemRestClient.getClient();
            return witClient.getTemplate(ctx.project.id, ctx.team.id, id);
        }

        function IsPropertyValid(taskTemplate, key) {
            if (taskTemplate.fields.hasOwnProperty(key) == false) {
                return false;
            }
            if (key.indexOf('System.Tags') >= 0) { //not supporting tags for now
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@me') { //current identity is handled later
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@currentiteration') { //current iteration is handled later
                return false;
            }

            return true;
        }

        function replaceReferenceToParentField(fieldValue, currentWorkItem) {
            var filters = fieldValue.match(/[^{\}]+(?=})/g);
            if (filters) {
                for (var i = 0; i < filters.length; i++) {
                    var parentField = filters[i];
                    var parentValue = currentWorkItem[parentField];

                    fieldValue = fieldValue.replace('{' + parentField + '}', parentValue)
                }
            }
            return fieldValue;
        }

        /**
         * Create the child task work item based on the rules from the task work item template.
         * @param {*} currentWorkItem 
         * @param {*} taskTemplate 
         * @param {*} teamSettings 
         */
        function createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings) {
            
            // Create the new child task work item
            var workItem = [];

            // Iteration through every field in the task template
            for (var key in taskTemplate.fields) {

                // Check whether we are supporting the specific field / property in the task template
                if (IsPropertyValid(taskTemplate, key)) {

                    // If field value is empty, copy the value from the parent
                    if (taskTemplate.fields[key] == '') {

                        // Check if the parent work item has a value to copy from. If so, use it.
                        if (currentWorkItem[key] != null) {

                            // Copy the field value from the parent work item to the child task work item
                            workItem.push({ "op": "add", "path": "/fields/" + key, "value": currentWorkItem[key] })
                        }
                    }
                    else {

                        var fieldValue = taskTemplate.fields[key];

                        //check for references to parent fields - {fieldName}
                        fieldValue = replaceReferenceToParentField(fieldValue, currentWorkItem);

                        workItem.push({ "op": "add", "path": "/fields/" + key, "value": fieldValue })
                    }
                }
            }

            // If template has no title field copies value from parent
            if (taskTemplate.fields['System.Title'] == null){
                workItem.push({ "op": "add", "path": "/fields/System.Title", "value": currentWorkItem['System.Title'] })
            }

            // If template has no AreaPath field copies value from parent
            if (taskTemplate.fields['System.AreaPath'] == null){
                workItem.push({ "op": "add", "path": "/fields/System.AreaPath", "value": currentWorkItem['System.AreaPath'] })
            }

            // If template has no IterationPath field copies value from parent, check if IterationPath field value is @currentiteration
            if (taskTemplate.fields['System.IterationPath'] == null){
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": currentWorkItem['System.IterationPath'] })
            } else if (taskTemplate.fields['System.IterationPath'].toLowerCase() == '@currentiteration') {
                // Check that teamSettings.defaultIteration is not null and has a path
                if (teamSettings && teamSettings.defaultIteration && teamSettings.defaultIteration.path) {
                    WriteLog('Info: Creating work item with team default iteration path.');
                    workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": teamSettings.backlogIteration.name + teamSettings.defaultIteration.path })
                } else {
                    WriteLog('Warning: No default or current iteration path defined in team settings. Falling back to parent iteration path.');
                    workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": currentWorkItem['System.IterationPath'] })
                }
            }

            // Check if AssignedTo field value is @me
            if (taskTemplate.fields['System.AssignedTo'] != null) {
                if (taskTemplate.fields['System.AssignedTo'].toLowerCase() == '@me') {
                    workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": ctx.user.uniqueName })
                }
            }

            // Copy tags from task template to new task work item // Work Item Template field for tags is called 'System.Tags-Add', but child task work item field is called 'System.Tags'
            if(taskTemplate.fields['System.Tags-Add'] != undefined) {
                workItem.push({ "op": "add", "path": "/fields/System.Tags", "value": taskTemplate.fields['System.Tags-Add'] })
            }

            return workItem;
        }

        function createWorkItem(service, currentWorkItem, taskTemplate, teamSettings) {

            var witClient = _WorkItemRestClient.getClient();

            var newWorkItem = createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings);

            return witClient.createWorkItem(newWorkItem, VSS.getWebContext().project.name, taskTemplate.workItemTypeName)
                .then(function (created) {
                    // Add relation to the parent and then save the parent form
                    if (service != null) {
                        // Wrap addWorkItemRelations to normalize return type (some SDKs don't support .catch)
                        return Q.Promise(function (resolve, reject) {
                            try {
                                var relResult = service.addWorkItemRelations([
                                    { rel: "System.LinkTypes.Hierarchy-Forward", url: created.url }
                                ]);
                                if (relResult && typeof relResult.then === 'function') {
                                    // Use then(success, error) to support jQuery/Q-style promises
                                    relResult.then(function () { resolve(); }, function (e) { reject(e); });
                                } else {
                                    // Synchronous/no promise
                                    resolve();
                                }
                            } catch (e) {
                                reject(e);
                            }
                        }).then(function () {
                            // Prefer save() which returns a promise to avoid race conditions on first run
                            if (typeof service.save === 'function') {
                                return service.save();
                            }
                            // Fallback to beginSaveWorkItem if save() is not available
                            return Q.Promise(function (resolve, reject) {
                                try {
                                    service.beginSaveWorkItem(function () { resolve(); }, function (error) { reject(error); });
                                } catch (e) { reject(e); }
                            });
                        }, function (err) {
                            var msg = (err && (err.message || err.statusText)) ? (err.message || err.statusText) : (typeof err === 'string' ? err : JSON.stringify(err));
                            var tName = (taskTemplate && taskTemplate.name) ? ('"' + taskTemplate.name + '"') : 'unknown';
                            var tId = (taskTemplate && taskTemplate.id) ? taskTemplate.id : 'n/a';
                            WriteLog('Failed to add relation for template ' + tName + ' (id: ' + tId + '): ' + msg);
                            // Re-throw to be handled by upstream catch
                            throw err;
                        });
                    } else {
                        // Save using REST client by updating relations on the parent work item
                        var workItemId = currentWorkItem['System.Id'];
                        var document = [{
                            op: "add",
                            path: '/relations/-',
                            value: {
                                rel: "System.LinkTypes.Hierarchy-Forward",
                                url: created.url,
                                attributes: {
                                    isLocked: false,
                                }
                            }
                        }];

                        return witClient.updateWorkItem(document, workItemId)
                            .then(function () {
                                VSS.getService(VSS.ServiceIds.Navigation).then(function (navigationService) {
                                    navigationService.reload();
                                });
                            });
                    }
                });
        }

        function AddTasksOnForm(service) {

            service.getId()
                .then(function (workItemId) {
                    return AddTasks(workItemId, service)
                });
        }

        function AddTasksOnGrid(workItemId) {

            return AddTasks(workItemId, null)
        }

        function AddTasks(workItemId, service) {

            var witClient = _WorkItemRestClient.getClient();
            var workClient = workRestClient.getClient();

            var team = {
                projectId: ctx.project.id,
                teamId: ctx.team.id
            };

            workClient.getTeamSettings(team)
                .then(function (teamSettings) {
                    // Get the current values for a few of the common fields
                    witClient.getWorkItem(workItemId)
                        .then(function (value) {
                            var currentWorkItem = value.fields;

                            currentWorkItem['System.Id'] = workItemId;

                            var workItemType = currentWorkItem["System.WorkItemType"];
                            GetChildTypes(witClient, workItemType)
                                .then(function (childTypes) {
                                    if (childTypes == null)
                                        return;
                                    // get Templates
                                    getTemplates(childTypes)
                                        .then(function (response) {
                                            if (response.length == 0) {
                                                ShowDialog('No ' + childTypes + ' templates found. Please add ' + childTypes + ' templates for the project team.');
                                                return;
                                            }
                                            // Create children alphabetically.
                                            var templates = response.sort(SortTemplates);
                                            var chain = Q.when();
                                            templates.forEach(function (template) {
                                                chain = chain.then(createChildFromTemplate(witClient, service, currentWorkItem, template, teamSettings));
                                            });
                                            return chain;

                                        });
                                });
                        })
                })
        }

        function createChildFromTemplate(witClient, service, currentWorkItem, template, teamSettings) {
            return function () {
                return getTemplate(template.id)
                    .then(function (taskTemplate) {
                        // Create child when filters match
                        if (IsValidTemplateWIT(currentWorkItem, taskTemplate) && IsValidTemplateTitle(currentWorkItem, taskTemplate)) {
                            // Return the promise so the chain waits and errors are handled upstream
                            return createWorkItem(service, currentWorkItem, taskTemplate, teamSettings);
                        }
                        // No-op: maintain chain with a resolved promise
                        return Q.when();
                    })
                    .catch(function (err) {
                        // Swallow to avoid noisy unhandled rejections in console; log for diagnostics
                        var msg = (err && (err.message || err.statusText)) ? (err.message || err.statusText) : (typeof err === 'string' ? err : JSON.stringify(err));
                        var tName = (template && template.name) ? ('"' + template.name + '"') : 'unknown';
                        var tId = (template && template.id) ? template.id : 'n/a';
                        WriteLog('Failed to create child from template ' + tName + ' (id: ' + tId + '): ' + msg);
                        return Q.when();
                    });
            };
        }

        /**
         * Check whether the criteria provided in the child work item template description matches the 
         * current work item. There are two different ways to provide criteria: 1) Using JSON to specify 
         * complex filtering rules; 2) Using square brackets to specify the parent work item types delimited
         * by commas (e.g. "[Product Backlog Item, Bug]").
         * @param {*} currentWorkItem 
         * @param {*} taskTemplate 
         */
        function IsValidTemplateWIT(currentWorkItem, taskTemplate) {

            // Try to extract a JSON object from the template description
            var extracted = extractJSON(
                taskTemplate.description,
                'template "' + (taskTemplate && taskTemplate.name ? taskTemplate.name : 'unknown') + '" (id: ' + (taskTemplate && taskTemplate.id ? taskTemplate.id : 'n/a') + ')'
            );
            var jsonFilters = extracted && extracted[0];

            // Proceed only if we have an object with an array applywhen
            if (jsonFilters && typeof jsonFilters === 'object' && Array.isArray(jsonFilters.applywhen)) {

                // Check whether any of the criteria specified in the child work item template JSON matches the current work item
                var someMatch = jsonFilters.applywhen.some(function (el) {
                    try {
                        return (
                            matchField('System.BoardColumn', currentWorkItem, el) &&
                            matchField('System.BoardLane', currentWorkItem, el) &&
                            matchField('System.State', currentWorkItem, el) &&
                            matchField('System.Tags', currentWorkItem, el) &&
                            matchField('System.Title', currentWorkItem, el) &&
                            matchField('System.AreaPath', currentWorkItem, el) &&
                            matchField('System.IterationPath', currentWorkItem, el) &&
                            matchField('System.WorkItemType', currentWorkItem, el)
                        );
                    } catch (e) {
                        // If a single rule is malformed, skip it instead of throwing
                        WriteLog('Skipping malformed filter rule: ' + (e && e.message ? e.message : e));
                        return false;
                    }
                });

                return someMatch;
            } 
            // Check whether the current work item type was specified using the basic square brackets approach in the child work item template description
            else {

                // Parse the criteria in the square brackets
                var filters = taskTemplate.description.match(/[^[\]]+(?=])/g);

                // Find whether the current work item matches
                if (filters) {
                    for (var i = 0; i < filters.length; i++) {
                        var found = filters[i].split(',').find(function (f) { return f.trim().toLowerCase() == currentWorkItem["System.WorkItemType"].toLowerCase() });
                        if (found) {
                            return true;
                        }
                    }
                } 
                return false;
            }
        }

        function IsValidTemplateTitle(currentWorkItem, taskTemplate) {
            // Title filtering is handled within JSON rules via IsValidTemplateWIT/matchField('System.Title').
            // For non-JSON descriptions (basic bracket syntax), there is no title filter. Always allow.
            try {
                var extracted = extractJSON(
                    taskTemplate && taskTemplate.description ? taskTemplate.description : "",
                    'template "' + (taskTemplate && taskTemplate.name ? taskTemplate.name : 'unknown') + '" (id: ' + (taskTemplate && taskTemplate.id ? taskTemplate.id : 'n/a') + ')'
                );
                var hasJson = extracted && extracted[0] && typeof extracted[0] === 'object';
                return true; // JSON case handled elsewhere; basic mode has no title filter
            } catch (e) {
                return true;
            }
        }

        function findWorkTypeCategory(categories, workItemType) {
            for (category of categories) {
                var found = category.workItemTypes.find(function (w) { return w.name == workItemType; });
                if (found != null) {
                    return category;
                }
            }
        }

        function GetChildTypes(witClient, workItemType) {

            return witClient.getWorkItemTypeCategories(VSS.getWebContext().project.name)
                .then(function (response) {
                    var categories = response;
                    var category = findWorkTypeCategory(categories, workItemType);

                    if (category !== null) {
                        var requests = [];
                        var workClient = workRestClient.getClient();

                        var team = {
                            projectId: ctx.project.id,
                            teamId: ctx.team.id
                        };

                        bugsBehavior = workClient.getTeamSettings(team).bugsBehavior; //Off, AsTasks, AsRequirements

                        if (category.referenceName === 'Microsoft.EpicCategory') {
                            return witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.FeatureCategory')
                                .then(function (response) {
                                    var category = response;

                                    return category.workItemTypes.map(function (item) { return item.name; });
                                });
                        } else if (category.referenceName === 'Microsoft.FeatureCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.RequirementCategory'));
                            if (bugsBehavior === 'AsRequirements') { requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.RequirementCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                            if (bugsBehavior === 'AsTasks') { requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.BugCategory' && bugsBehavior === 'AsRequirements') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        } else if (category.referenceName === 'Microsoft.TaskCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        } else if (category.referenceName == 'Microsoft.BugCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        }

                        return Q.all(requests)
                            .then(function (response) {
                                var categories = response;

                                var result = [];
                                categories.forEach(function (category) {
                                    category.workItemTypes.forEach(function (workItemType) {
                                        result.push(workItemType.name);
                                    });
                                });

                                return result;
                            });
                    }
                });
        }

        function SortTemplates(a, b) {
            var nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
            if (nameA < nameB) //sort string ascending
                return -1;
            if (nameA > nameB)
                return 1;
            return 0; //default return value (no sorting)
        }

        function extractJSON(str, contextLabel) {
            var firstOpen = -1, firstClose = -1, candidate;
            var attempts = 0;
            var lastError = null;
            var contextMsg = contextLabel ? (' for ' + contextLabel) : '';
            firstOpen = str.indexOf('{');
            if (firstOpen != -1) {
                do {
                    firstClose = str.lastIndexOf('}');
                    if (firstClose <= firstOpen) {
                        if (attempts > 0) {
                            WriteLog('extractJSON: failed to parse JSON' + contextMsg + ' after ' + attempts + ' attempts. Last error: ' + lastError);
                        }
                        return null;
                    }
                    do {
                        candidate = str.substring(firstOpen, firstClose + 1);
                        try {
                            var res = JSON.parse(candidate);
                            return [res, firstOpen, firstClose + 1];
                        }
                        catch (e) {
                            attempts++;
                            lastError = (e && e.message) ? e.message : e;
                        }
                        firstClose = str.substr(0, firstClose).lastIndexOf('}');
                    } while (firstClose > firstOpen);
                    firstOpen = str.indexOf('{', firstOpen + 1);
                } while (firstOpen != -1);
                // Exhausted search without success
                if (attempts > 0) {
                    WriteLog('extractJSON: failed to parse JSON' + contextMsg + ' after ' + attempts + ' attempts. Last error: ' + lastError);
                }
                return null;
            } else {
                return null;
            }
        }

        // TODO: Remove if no longer used
        function IsJsonString(str) {
            try {
                JSON.parse(str);
            } catch (e) {
                return false;
            }
            return true;
        }

        /**
         * Match a specific field in the current work item against a filter element.
         * @param {*} fieldName // The name of the field to match
         * @param {*} currentWorkItem // The current work item being evaluated
         * @param {*} filterElement // The filter element containing the criteria
         * @returns 
         */
        function matchField(fieldName, currentWorkItem, filterElement) {

            // Get the filter value for the specific field (e.g. System.State)
            var filterVal = filterElement[fieldName];

            // If no filter provided, always a match
            if (typeof filterVal === 'undefined' || filterVal === null) {
                return true;
            }

            // Get the current value for the specific field (e.g. System.State)
            var curValRaw = currentWorkItem ? currentWorkItem[fieldName] : undefined;

            // Title: wildcard match, case-insensitive, null-safe
            if (fieldName === 'System.Title') {
                var title = (curValRaw == null ? '' : curValRaw.toString());
                var rule = (filterVal == null ? '' : filterVal.toString());
                return matchWildcardString(title, rule);
            }

            // Tags: normalize to arrays and check that current contains all filter tags
            if (fieldName === 'System.Tags') {
                var toTagArray = function (val) {
                    if (Array.isArray(val)) return val;
                    if (val == null) return [];
                    // Azure DevOps uses semicolon-separated tags; accept commas/newlines too
                    return val
                        .toString()
                        .split(/[;\,\n]/)
                        .map(function (s) { return s.trim(); })
                        .filter(function (s) { return s; });
                };

                var currentTags = toTagArray(curValRaw).map(function (s) { return s.toLowerCase(); });
                var filterTags = toTagArray(filterVal).map(function (s) { return s.toLowerCase(); });

                return filterTags.every(function (tag) { return currentTags.indexOf(tag) !== -1; });
            }

            // For non-tag fields: if filter provides an array, treat as any-of values (case-insensitive)
            if (Array.isArray(filterVal)) {
                var curStr = (curValRaw == null ? '' : curValRaw.toString().toLowerCase());
                return filterVal.some(function (v) {
                    return (v == null ? '' : v.toString().toLowerCase()) === curStr;
                });
            }

            // Scalar compare (case-insensitive). If current value is missing, not a match
            if (curValRaw == null) return false;
            return filterVal.toString().toLowerCase() === curValRaw.toString().toLowerCase();
        }

        /**
         * Compare a strong to another wildcard string (i.e. rule). Examples:
         * - "a*b" => everything that starts with "a" and ends with "b"
         * - "a*" => everything that starts with "a"
         * - "*b" => everything that ends with "b"
         * - "*a*" => everything that has an "a" in it
         * - "*a*b*"=> everything that has an "a" in it, followed by anything, followed by a "b", followed by anything
         * https://stackoverflow.com/questions/26246601/wildcard-string-comparison-in-javascript
         * @param {*} str 
         * @param {*} rule 
         */
        function matchWildcardString(str, rule) {
            // Coerce to strings and do case-insensitive match with safe escaping
            var s = (str == null ? '' : String(str));
            var r = (rule == null ? '' : String(rule));
            var escapeRegex = function (x) { return x.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1"); };
            return new RegExp("^" + r.split("*").map(escapeRegex).join(".*") + "$", "i").test(s);
        }

        /**
         * Compare two arrays.
         * @param {*} a 
         * @param {*} b 
         */
        function arraysEqual(a, b) {
            if (a === b) return true;
            if (a == null || b == null) return false;
            if (a.length != b.length) return false;

            // If you don't care about the order of the elements inside
            // the array, you should sort both arrays here.
            // Please note that calling sort on an array will modify that array.
            // you might want to clone your array first.

            for (var i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }

        function ShowDialog(message) {

            var dialogOptions = {
                title: "Create Child Tasks",
                width: 300,
                height: 200,
                resizable: false,
            };

            VSS.getService(VSS.ServiceIds.Dialog).then(function (dialogSvc) {

                dialogSvc.openMessageDialog(message, dialogOptions)
                    .then(function (dialog) {
                        //
                    }, function (dialog) {
                        //
                    });
            });
        }

        function WriteLog(msg) {
            console.log('Create Child Tasks: ' + msg);
        }

        return {

            create: function (context) {
                WriteLog('init');

                ctx = VSS.getWebContext();

                getWorkItemFormService().then(function (service) {
                    service.hasActiveWorkItem()
                        .then(function success(response) {
                            if (response == true) {
                                //form is open
                                AddTasksOnForm(service);
                            }
                            else {
                                // on grid
                                if (context.workItemIds && context.workItemIds.length > 0) {

                                    context.workItemIds.forEach(function (workItemId) {
                                        AddTasksOnGrid(workItemId);
                                    });
                                }
                                else if (context.id) {
                                    var workItemId = context.id;
                                    AddTasksOnGrid(workItemId);
                                }
                            }
                        });
                })
            },
        }
    });
