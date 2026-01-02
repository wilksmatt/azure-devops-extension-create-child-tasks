define(["TFS/WorkItemTracking/Services", "TFS/WorkItemTracking/RestClient", "TFS/Work/RestClient", "q", "VSS/Controls", "VSS/Controls/StatusIndicator", "VSS/Controls/Dialogs", "./logger", "./config", "./rest"],
    function (_WorkItemServices, _WorkItemRestClient, workRestClient, Q, Controls, StatusIndicator, Dialogs, Logger, Config, Rest) {

        var ctx = null;

        // ===== Entry Points =====

        /**
         * Get the Work Item Form Service instance.
         * @returns {Promise} A promise that resolves to the Work Item Form Service instance.
         */
        function getWorkItemFormService() {
            return _WorkItemServices.WorkItemFormService.getService();
        }

        /**
         * Replaces `{ParentField}` tokens in a template field value using the parent work item.
         * @param {string} fieldValue Template field value (may contain tokens).
         * @param {*} currentWorkItem Parent work item fields map.
         * @returns {string} Resolved field value.
         */
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
         * Checks if a template field should be applied to the child work item.
         * Skips unsupported keys and special tokens handled elsewhere.
         * @param {*} taskTemplate Template object with fields.
         * @param {string} key Field name.
         * @returns {boolean} Whether the field is valid to process.
         */
        function isPropertyValid(taskTemplate, key) {
            // Own-property check handled in the loop for clarity and minor perf gain
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

        /**
         * Builds the JSON patch document for a new child work item using a template.
         * Copies/sets fields from the parent and template, honoring special tokens.
         * @param {*} currentWorkItem Parent work item fields map.
         * @param {*} taskTemplate Template object with fields and metadata.
         * @param {*} teamSettings Team settings used for iteration resolution.
         * @returns Array of JSON patch operations for work item creation.
         */
        function createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings) {
            
            // Create the new child task work item
            var workItem = [];

            // Iteration through every field in the task template
            for (var key in taskTemplate.fields) {

                // Skip inherited properties early
                if (!Object.prototype.hasOwnProperty.call(taskTemplate.fields, key)) {
                    continue;
                }

                // Check whether we are supporting the specific field / property in the task template
                if (isPropertyValid(taskTemplate, key)) {

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
                    Logger.info('Creating work item (template: ' + getTemplateName(taskTemplate) + ') with team default iteration path.');
                    workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": teamSettings.backlogIteration.name + teamSettings.defaultIteration.path })
                } else {
                    Logger.warn('No default or current iteration path defined in team settings for template ' + getTemplateName(taskTemplate) + '. Falling back to parent iteration path.');
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

        /**
         * Entry point for the form context: resolves current id and creates children.
         * @param {*} service Work Item Form Service instance.
         */
        function addTasksOnForm(service) {

            service.getId()
                .then(function (workItemId) {
                    return addTasks(workItemId, service)
                });
        }

        /**
         * Entry point for the grid context: creates children for a given id.
         * @param {number} workItemId Parent work item id.
         * @returns {Promise}
         */
        function addTasksOnGrid(workItemId) {

            return addTasks(workItemId, null)
        }

        /**
         * Orchestrates fetching team settings, parent fields, templates, filtering, and creation.
         * Prefetches template details in parallel; creates matched children sequentially.
         * @param {number} workItemId Parent work item id.
         * @param {*} service Work Item Form Service instance or null.
         * @returns {Promise}
         */
        function addTasks(workItemId, service) {

            // SDK clients no longer required here after REST migration

            var teamSettingsStart = Date.now();
            Rest.getTeamSettings()
                .then(function (teamSettings) {
                    Logger.timestamp('Team settings resolved', teamSettingsStart);
                    // Get the current values for a few of the common fields
                    var wiStart = Date.now();
                    // Prefer REST over SDK for better Chromium performance
                        return Rest.getWorkItem(workItemId, [
                        'System.Id',
                        'System.WorkItemType',
                        'System.State',
                        'System.AreaPath',
                        'System.IterationPath',
                        'System.BoardColumn',
                        'System.BoardLane',
                        'System.Title',
                        'System.Tags'
                    ])
                        .then(function (value) {
                            Logger.timestamp('Fetched current work item', wiStart);
                            if (!value || !value.fields) {
                                // Proceed without extra debug; downstream will fail if fields are missing
                                throw new Error('Failed to load work item via REST');
                            }
                            var currentWorkItem = value.fields;

                            currentWorkItem['System.Id'] = workItemId;

                            var workItemType = currentWorkItem["System.WorkItemType"];
                            var childTypesStart = Date.now();
                            getChildTypes(workItemType, teamSettings)
                                .then(function (childTypes) {
                                    Logger.timestamp('Resolved valid child types', childTypesStart);
                                    if (childTypes == null)
                                        return;
                                    // get Templates
                                    var tmplFetchStart = Date.now();
                                    getTemplates(childTypes)
                                        .then(function (response) {
                                            Logger.timestamp('Templates fetched', tmplFetchStart);

                                            // Check for no templates
                                            if (response.length == 0) {
                                                Logger.warn('No templates found of type: ' + childTypes + '. Please add templates for this project team.');
                                                showDialog('No templates found of type: ' + childTypes + '. Please add templates for this project team.');
                                                return;
                                            }

                                            // Initial list without sorting; we'll sort after prefiltering
                                            var templates = response;

                                            // Prefilter templates by description before fetching details
                                            var prefilterStart = Date.now();
                                            var candidates = [];
                                            for (var i = 0; i < templates.length; i++) {
                                                var t = templates[i];
                                                try {
                                                    if (isValidTemplateWIT(currentWorkItem, t)) {
                                                        candidates.push(t);
                                                    }
                                                } catch (e) {
                                                    // skip malformed templates
                                                }
                                            }
                                            Logger.timestamp('Templates prefiltered (' + candidates.length + ')', prefilterStart);

                                            // Check whether any candidates remain; if none, log and exit
                                            if (candidates.length === 0) {
                                                Logger.warn('No templates matched. Please check your template descriptions and rules.');
                                                return;
                                            }
                                            
                                            // Sort only the candidates to reduce work
                                            var sortCandidatesStart = Date.now();
                                            candidates = candidates.sort(sortTemplates);
                                            Logger.timestamp('Candidates sorted (' + candidates.length + ')', sortCandidatesStart);
                                            
                                            // Prefetch only candidate details in parallel, then create sequentially
                                            var detailFetchStart = Date.now();
                                            var detailPromises = candidates.map(function(t){ return getTemplate(t.id).then(function(dt){ return dt; }, function(){ return null; }); });
                                            return Q.all(detailPromises).then(function(details){
                                                Logger.timestamp('Template details fetched', detailFetchStart);

                                                // Use prefiltered candidates: no need to re-check description rules here
                                                var toCreate = [];
                                                for (var i = 0; i < details.length; i++) {
                                                    var taskTemplate = details[i];
                                                    if (taskTemplate) {
                                                        toCreate.push(taskTemplate);
                                                    }
                                                }
                                                
                                                // Create sequentially to avoid relation/save races
                                                var chain = Q.when();
                                                var createStart = Date.now();
                                                toCreate.forEach(function(taskTemplate){
                                                    chain = chain.then(function(){
                                                        var newWorkItem = createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings);
                                                           return Rest.createChildWorkItem(currentWorkItem, taskTemplate, newWorkItem).catch(function(err){
                                                            var msg = (err && (err.message || err.statusText)) ? (err.message || err.statusText) : (typeof err === 'string' ? err : JSON.stringify(err));
                                                            Logger.error('Failed to create child from template "' + getTemplateName(taskTemplate) + '": ' + msg);
                                                            return Q.when();
                                                        });
                                                    });
                                                });
                                                return chain.then(function(){
                                                    Logger.timestamp('Child creation completed', createStart);
                                                    // For REST path in grid context, refresh once at the end
                                                    if (service == null) {
                                                        return VSS.getService(VSS.ServiceIds.Navigation).then(function (navigationService) {
                                                            navigationService.reload();
                                                        });
                                                    }
                                                });
                                            });
                                        });
                                });
                        });
                });
        }

        // ===== Data Fetching =====

        /**
         * Fetches all templates for the given work item types in the current project/team.
         * @param {*} workItemTypes List of work item type names to fetch templates for.
         * @returns Promise resolving to a flat array of template objects.
         */
        function getTemplates(workItemTypes) {
            return Rest.getTemplatesForTypes(workItemTypes);
        }

        /**
         * Fetches a full template definition by ID for the current project/team.
         * @param {*} id Template ID.
         * @returns Promise resolving to the detailed template object.
         */
        function getTemplate(id) {
            return Rest.getTemplateDetail(id);
        }

        // ===== Matching & Filtering =====

        /**
         * Check whether the criteria provided in the child work item template description matches the 
         * current work item. There are two different ways to provide criteria: 1) Using JSON to specify 
         * complex filtering rules; 2) Using square brackets to specify the parent work item types delimited
         * by commas (e.g. "[Product Backlog Item, Bug]").
         * @param {*} currentWorkItem 
         * @param {*} taskTemplate 
         */
        function isValidTemplateWIT(currentWorkItem, taskTemplate) {

            // Try to extract a JSON object from the template description
            var extracted = extractJSON(
                taskTemplate.description,
                getTemplateName(taskTemplate)
            );
            var jsonFilters = extracted && extracted[0];

            // Proceed only if we have an object with an array applywhen
            if (jsonFilters && typeof jsonFilters === 'object' && Array.isArray(jsonFilters.applywhen)) {

                // Recommended order for cheapest-first checks; short-circuit on first mismatch
                var orderedFields = [
                    'System.WorkItemType',
                    'System.State',
                    'System.AreaPath',
                    'System.IterationPath',
                    'System.BoardColumn',
                    'System.BoardLane',
                    'System.Title',
                    'System.Tags'
                ];

                var someMatch = jsonFilters.applywhen.some(function (el) {
                    try {
                        for (var i = 0; i < orderedFields.length; i++) {
                            var f = orderedFields[i];
                            if (typeof el[f] === 'undefined') {
                                continue; // skip fields not present in the rule
                            }
                            if (!matchField(f, currentWorkItem, el)) {
                                return false; // short-circuit on first mismatch
                            }
                        }
                        return true;
                    } catch (e) {
                        // If a single rule is malformed, skip it instead of throwing
                        Logger.warn('Skipping malformed filter rule: ' + (e && e.message ? e.message : e));
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

        /**
         * Match a specific field in the current work item against a filter element.
         * @param {*} fieldName // The name of the field to match
         * @param {*} currentWorkItem // The current work item being evaluated
         * @param {*} filterElement // The filter element containing the criteria
         * @returns 
         */
        function matchField(fieldName, currentWorkItem, filterElement) {

            // Build or reuse normalization caches on the current work item to avoid repeated allocations
            var norm = currentWorkItem.__norm;
            if (!norm) {
                norm = {
                    lower: {},
                    tagsLowerSet: null,
                    titleRegexCache: {}
                };
                // Lowercase common scalar fields once
                var scalarFields = [
                    'System.WorkItemType',
                    'System.State',
                    'System.AreaPath',
                    'System.IterationPath',
                    'System.BoardColumn',
                    'System.BoardLane',
                    'System.Title'
                ];
                for (var si = 0; si < scalarFields.length; si++) {
                    var sf = scalarFields[si];
                    var v = currentWorkItem[sf];
                    norm.lower[sf] = (v == null ? '' : v.toString().toLowerCase());
                }
                // Tags set (lowercased)
                var tagsRaw = currentWorkItem['System.Tags'];
                if (tagsRaw != null) {
                    // Azure DevOps stores tags as a single semicolon-delimited string. Be strict on ';' splitting,
                    // and defensively normalize unicode whitespace to avoid hidden mismatch.
                    var rawStr = tagsRaw.toString().replace(/\u00a0|\s+/g, ' ').trim();
                    var arr = rawStr
                        .split(/;+/)
                        .map(function (s) { return s.trim().toLowerCase(); })
                        .filter(function (s) { return s; });
                    var set = {};
                    for (var ti = 0; ti < arr.length; ti++) { set[arr[ti]] = true; }
                    norm.tagsLowerSet = set;
                } else {
                    norm.tagsLowerSet = {};
                }
                currentWorkItem.__norm = norm;
            }

            // Get the filter value for the specific field (e.g. System.State)
            var filterVal = filterElement[fieldName];

            // If no filter provided, always a match
            if (typeof filterVal === 'undefined' || filterVal === null) {
                return true;
            }

            // Get the current value for the specific field (e.g. System.State)
            var curValRaw = currentWorkItem ? currentWorkItem[fieldName] : undefined;

            // Title: wildcard match, case-insensitive, null-safe, with regex cache
            if (fieldName === 'System.Title') {
                var title = norm.lower['System.Title'];
                var rule = (filterVal == null ? '' : filterVal.toString());
                var cached = norm.titleRegexCache[rule];
                if (!cached) {
                    var escapeRegex = function (x) { return x.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1"); };
                    cached = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$", "i");
                    norm.titleRegexCache[rule] = cached;
                }
                return cached.test(title);
            }

            // Tags: normalize to arrays and check that current contains all filter tags
            if (fieldName === 'System.Tags') {
                // Accept common aliases if rule used different key names
                if (typeof filterVal === 'undefined' || filterVal === null) {
                    filterVal = (typeof filterElement['Tags'] !== 'undefined') ? filterElement['Tags'] : filterVal;
                    filterVal = (typeof filterVal === 'undefined' || filterVal === null) && typeof filterElement['System.Tags-Add'] !== 'undefined' ? filterElement['System.Tags-Add'] : filterVal;
                }

                var toTagArray = function (val) {
                    if (Array.isArray(val)) return val.map(function (s) { return (s == null ? '' : s.toString()).trim().toLowerCase(); }).filter(function (s) { return s; });
                    if (val == null) return [];
                    // Filters may use commas or semicolons; support both. Normalize unicode spaces.
                    var raw = val.toString().replace(/\u00a0|\s+/g, ' ').trim();
                    return raw
                        .split(/[;,]+/)
                        .map(function (s) { return s.trim().toLowerCase(); })
                        .filter(function (s) { return s; });
                };
                var filterTags = toTagArray(filterVal);
                for (var i = 0; i < filterTags.length; i++) {
                    if (!norm.tagsLowerSet[filterTags[i]]) {
                        return false;
                    }
                }
                return true;
            }

            // For non-tag fields: if filter provides an array, treat as any-of values (case-insensitive)
            if (Array.isArray(filterVal)) {
                var curStr = norm.lower[fieldName] || (curValRaw == null ? '' : curValRaw.toString().toLowerCase());
                return filterVal.some(function (v) {
                    return (v == null ? '' : v.toString().toLowerCase()) === curStr;
                });
            }

            // Scalar compare (case-insensitive). If current value is missing, not a match
            if (curValRaw == null) return false;
            var curLower = norm.lower[fieldName] || curValRaw.toString().toLowerCase();
            return filterVal.toString().toLowerCase() === curLower;
        }

        // ===== Child Type Resolution =====
        /**
         * Finds a work item type category containing the given type name.
         * @param {*} categories List of categories from the WIT client.
         * @param {string} workItemType Work item type name.
         * @returns {*} Matching category or undefined.
         */
        function findWorkTypeCategory(categories, workItemType) {
            for (var category of categories) {
                var found = category.workItemTypes.find(function (w) { return w.name == workItemType; });
                if (found != null) {
                    return category;
                }
            }
        }

        /**
         * Resolves valid child work item types based on the parent type and team bug behavior.
         * @param {*} witClient Work Item Tracking REST client.
         * @param {string} workItemType Parent work item type.
         * @returns {Promise<string[]>} Array of child type names.
         */
        function getChildTypes(workItemType, teamSettings) {

            return Rest.getWorkItemTypeCategories()
                .then(function (response) {
                    var categories = response;
                    var category = findWorkTypeCategory(categories, workItemType);

                    if (category != null) {
                        var requests = [];
                        var bugsBehavior = (teamSettings && teamSettings.bugsBehavior) || 'Off'; // Off, AsTasks, AsRequirements

                        if (category.referenceName === 'Microsoft.EpicCategory') {
                            return Rest.getWorkItemTypeCategory('Microsoft.FeatureCategory')
                                .then(function (response) {
                                    var category = response;

                                    return category.workItemTypes.map(function (item) { return item.name; });
                                });
                        } else if (category.referenceName === 'Microsoft.FeatureCategory') {
                            requests.push(Rest.getWorkItemTypeCategory('Microsoft.RequirementCategory'));
                            if (bugsBehavior === 'AsRequirements') { requests.push(Rest.getWorkItemTypeCategory('Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.RequirementCategory') {
                            requests.push(Rest.getWorkItemTypeCategory('Microsoft.TaskCategory'));
                            if (bugsBehavior === 'AsTasks') { requests.push(Rest.getWorkItemTypeCategory('Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.BugCategory' && bugsBehavior === 'AsRequirements') {
                            requests.push(Rest.getWorkItemTypeCategory('Microsoft.TaskCategory'));
                        } else if (category.referenceName === 'Microsoft.TaskCategory') {
                            requests.push(Rest.getWorkItemTypeCategory('Microsoft.TaskCategory'));
                        } else if (category.referenceName == 'Microsoft.BugCategory') {
                            requests.push(Rest.getWorkItemTypeCategory('Microsoft.TaskCategory'));
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

        // ===== Utilities =====

        /**
         * Case-insensitive alphabetical comparator for template names.
         * @param {*} a Template A.
         * @param {*} b Template B.
         * @returns {number} -1, 0, or 1.
         */
        function sortTemplates(a, b) {
            var nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
            if (nameA < nameB) //sort string ascending
                return -1;
            if (nameA > nameB)
                return 1;
            return 0; //default return value (no sorting)
        }

        /**
         * Extracts the first valid JSON object embedded in a freeform string.
         * Returns parsed object with start/end indices; null if none found.
         * @param {string} str Source string.
         * @param {string} contextLabel Label for diagnostic logging.
         * @returns {[object, number, number] | null}
         */
        function extractJSON(str, contextLabel) {
            // Optimize: fast-path, precompute brace indices, cap attempts, and avoid repeated scans
            str = str || '';
            var attempts = 0;
            var lastError = null;
            var MAX_ATTEMPTS = 100; // safety cap to avoid pathological cases

            // Fast-path: try whole trimmed string if it looks like a JSON object
            var trimmed = str.trim();
            if (trimmed.length > 1 && trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') {
                try {
                    var fastRes = JSON.parse(trimmed);
                    // Return indices relative to original string
                    var startIdx = str.indexOf(trimmed);
                    return [fastRes, startIdx, startIdx + trimmed.length];
                } catch (e) {
                    // Fall through to robust search
                    lastError = (e && e.message) ? e.message : e;
                }
            }

            // Precompute positions of opening and closing braces
            var opens = [];
            var closes = [];
            for (var i = 0; i < str.length; i++) {
                var ch = str.charAt(i);
                if (ch === '{') opens.push(i);
                else if (ch === '}') closes.push(i);
            }
            if (opens.length === 0 || closes.length === 0) {
                return null;
            }

            // Helper: quick brace-balance heuristic on slice to skip obviously invalid spans
            function isPossiblyBalanced(start, end) {
                var bal = 0;
                for (var j = start; j <= end; j++) {
                    var c = str.charAt(j);
                    if (c === '{') bal++;
                    else if (c === '}') {
                        bal--;
                        if (bal < 0) return false;
                    }
                }
                return bal >= 0; // allow extra opens; JSON.parse will be final arbiter
            }

            // Try pairs: for each open from left, try closes from right
            for (var oi = 0; oi < opens.length; oi++) {
                var start = opens[oi];
                for (var ci = closes.length - 1; ci >= 0; ci--) {
                    var end = closes[ci];
                    if (end <= start) break;
                    if (!isPossiblyBalanced(start, end)) continue;
                    var candidate = str.substring(start, end + 1);
                    try {
                        var res = JSON.parse(candidate);
                        return [res, start, end + 1];
                    } catch (e) {
                        attempts++;
                        lastError = (e && e.message) ? e.message : e;
                        if (attempts >= MAX_ATTEMPTS) {
                            Logger.warn('Failed to parse JSON for template "' + contextLabel + '" after ' + attempts + ' attempts (cap). Last error: ' + lastError);
                            return null;
                        }
                    }
                }
            }

            if (attempts > 0) {
                Logger.warn('Failed to parse JSON for template "' + contextLabel + '" after ' + attempts + ' attempts. Last error: ' + lastError);
            }
            return null;
        }

        /**
         * Shows a modal message dialog in Azure DevOps.
         * @param {string} message Message text to display.
         */
        function showDialog(message) {

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

        /**
         * Safely returns a template's display name for logging.
         * @param {*} taskTemplate Template object.
         * @returns {string}
         */
        function getTemplateName(taskTemplate) {
            try {
                var name = (taskTemplate && taskTemplate.name) ? taskTemplate.name : 'unknown';
                return name;
            } catch (e) {
                return 'unknown';
            }
        }

        return {

            create: function (context) {
                // Initialize logger with explicit runtime mode from config
                try { Logger.init(Config && Config.mode ? Config.mode : undefined); } catch (e) { /* ignore */ }
                Logger.timestamp.setInit(Date.now());
                Logger.debug('init');
                Logger.timestamp('Init started');

                ctx = VSS.getWebContext();

                getWorkItemFormService().then(function (service) {
                    service.hasActiveWorkItem()
                        .then(function success(response) {
                            if (response == true) {
                                //form is open
                                Logger.timestamp('Form detected');
                                addTasksOnForm(service);
                            }
                            else {
                                // on grid
                                if (context.workItemIds && context.workItemIds.length > 0) {

                                    Logger.timestamp('Grid detected: ' + context.workItemIds.length + ' ids');
                                    context.workItemIds.forEach(function (workItemId) {
                                        addTasksOnGrid(workItemId);
                                    });
                                }
                                else if (context.id) {
                                    var workItemId = context.id;
                                    Logger.timestamp('Grid detected: single id');
                                    addTasksOnGrid(workItemId);
                                }
                            }
                        });
                })
            },
        }
    });
