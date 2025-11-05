## Create Child Tasks ##

Azure DevOps offers team-specific work item templating as <a href="https://docs.microsoft.com/en-us/azure/devops/boards/backlogs/work-item-template?view=azure-devops&tabs=browser" target="_blank">core functionality</a> with which you can quickly apply pre-populated values for your team's commonly used fields per work item type. **Create Child Tasks** is an *extension* to Azure DevOps, which allows you to create multiple Task work items as children with a single click. Each Task work item is based on a single pre-defined Task template.

The child Task work items created by this extension are based on the hierarchy of work item types defined in the process template (<a href="https://docs.microsoft.com/en-us/azure/devops/boards/work-items/guidance/agile-process-workflow?view=azure-devops" target="_blank">Agile</a>, <a href="https://docs.microsoft.com/en-us/azure/devops/boards/work-items/guidance/scrum-process-workflow?view=azure-devops" target="_blank">Scrum</a>, <a href="https://docs.microsoft.com/en-us/azure/devops/boards/work-items/guidance/cmmi-process-workflow?view=azure-devops" target="_blank">CMMI</a>). For example, if you're using a process inherited from the agile template with a custom requirement-level type called defect and 3 Task templates defined, using this extension on a User Story or Defect work item will generate three child Tasks; one for each defined template.

## How-To Guide ##

### Defining Task Templates ###

Azure DevOps offers team-specific work item templating as core functionality with which you can quickly apply pre-populated values for your team's commonly used fields per work item type. View Microsoft's documentation about <a href="https://docs.microsoft.com/en-us/azure/devops/boards/backlogs/work-item-template" target="_blank">how to add and update work item templates</a>.

![Export](img/create-child-tasks-screenshot-manage-templates.png)

### Creating Task Template Filter Rules ###

With this extension, it's possible to specify which parent work items apply to each Task template by putting rules into the Task template *Description* field. There are two ways that you can specify these rules:

![Export](img/create-child-tasks-screenshot-manage-templates-filter-rules.png)

#### Basic ####

Put the list of applicable parent work item types in the child Task template's description field, like this:

```[Product Backlog Item, Bug]```

#### Advanced ####

Put a minified (single line) JSON string into the child Task template's description field. Supported fields and behaviors:

- System.WorkItemType: Single value or array (OR). Case-insensitive exact match.
- System.State: Single value or array (OR). Case-insensitive exact match.
- System.BoardColumn: Single value or array (OR). Case-insensitive exact match.
- System.BoardLane: Single value or array (OR). Case-insensitive exact match.
- System.Title: Wildcard string (e.g., "*API*"). To match multiple patterns, use multiple rule objects in `applywhen` (OR across rules).
- System.Tags: Single value or array. Arrays require all tags to be present (AND). For tag OR, use multiple rule objects in `applywhen`.
- System.AreaPath: Single value or array (OR). Exact path match (case-insensitive), no wildcards. Remember to escape backslashes in JSON.
- System.IterationPath: Single value or array (OR). Exact path match (case-insensitive), no wildcards. Remember to escape backslashes in JSON.

Example with all supported fields and OR logic:

```json
{
    "applywhen": [
        {
            "System.WorkItemType": ["Product Backlog Item", "Bug"],
            "System.State": ["Approved", "Committed"],
            "System.BoardColumn": ["Development", "Testing"],
            "System.BoardLane": ["Expedite", "Default"],
            "System.Title": "*API*",
            "System.Tags": ["Security", "Backend"],
            "System.AreaPath": [
                "Project\\Area Path\\Sub Path",
                "Project\\Area Path"
            ],
            "System.IterationPath": [
                "Project\\Iteration\\Sprint 1",
                "Project\\Iteration\\Sprint 2"
            ]
        },
        {
            "System.WorkItemType": "User Story",
            "System.Title": "*Integration*"
        }
    ]
}
```

### Applying Child Tasks ###

Find and select the *Create Child Tasks* option on the toolbar menu of the parent work item (e.g., Product Backlog Item, User Story, Bug).

![Export](img/create-child-tasks-screenshot-work-item-menu-item.png)

You should now have children associated with the open work item.

![Export](img/create-child-tasks-screenshot-work-item-tasks.png)

### Ordering Child Tasks ###

By default, the child Tasks are created and ordered alphabetically by the Task template name. If you want to customize the order, prefix template names with numbers.

![Export](img/create-child-tasks-screenshot-manage-templates-order.png)

When creating the tasks with the extension, the tasks will show up in the same order in the work item.

![Export](img/create-child-tasks-screenshot-board-work-item-tasks.png)

### Using 'Wildcards' for Title Filter Rules ###

You can apply a child task if the parent work item title matches completely or partially. Use a wildcard string in the filter rule with the asterisk character ("*").

```json
{
    "applywhen": [
        {
            "System.WorkItemType": "Product Backlog Item",
            "System.Title": "*WildcardString*"
        }
    ]
}
```

Wildcard examples:

```
- "a*"      Everything that starts with "a"
- "*b"      Everything that ends with "b"
- "a*b"     Everything that starts with "a" and ends with "b"
- "*a*"     Everything that has an "a" in it
- "*a*b*"   Everything that has an "a" in it, followed by anything, followed by a "b", followed by anything
```

### Using arrays for multiple values (OR) ###

Most fields accept either a single value or an array of values. When you provide an array, any one value may match (logical OR). This is useful when the same template should apply to several states, types, or other field values.

Example (multiple allowed values):

```json
{
    "applywhen": [
        {
            "System.WorkItemType": ["Product Backlog Item", "Bug"],
            "System.State": ["Approved", "Committed", "In Progress"],
            "System.IterationPath": [
                "Project\\Iteration\\Sprint 1",
                "Project\\Iteration\\Sprint 2"
            ]
        }
    ]
}
```

Notes and exceptions:
- System.Title: Use a single wildcard string (e.g., "*API*"). To match multiple title patterns, add multiple rule objects in `applywhen` (OR across rules).
- System.Tags: Arrays here mean all listed tags must be present on the parent (logical AND). For example, ["Security", "Backend"] requires both tags. For tag OR, use separate rule objects in `applywhen` (rules are combined with OR):

    ```json
    {
        "applywhen": [
            { "System.WorkItemType": "User Story", "System.Tags": "Security" },
            { "System.WorkItemType": "User Story", "System.Tags": "Backend" }
        ]
    }
    ```

### Filtering by AreaPath ###

You can target templates to specific Area Paths using the advanced JSON rules in a template's Description. AreaPath must match the parent work item’s Area Path value (case-insensitive) and supports either a single value or an array of allowed values.

- Example (single AreaPath):

```json
{
    "applywhen": [
        {
            "System.WorkItemType": "Product Backlog Item",
            "System.AreaPath": "Project\\Area Path\\Sub Path"
        }
    ]
}
```

- Example (multiple AreaPaths – any-of will match):

```json
{
    "applywhen": [
        {
            "System.WorkItemType": "Product Backlog Item",
            "System.AreaPath": [
                "Project\\Area Path\\Sub Path",
                "Project\\Area Path"
            ]
        }
    ]
}
```

Behavior notes:
- Matching is case-insensitive, but paths must otherwise match exactly (no wildcards on AreaPath).
- To include multiple sub-areas, list each full path explicitly in the array.
- Tip: Copy the exact Area Path from a work item or from Project Settings → Boards → Areas.
- Important: In JSON, backslash is an escape character. Azure DevOps Area Paths use backslashes (\\) to denote hierarchy. To represent a literal backslash in JSON you must escape it as \\\\.

## Credits ##

Cloned from https://github.com/figueiredorui/1-click-child-links