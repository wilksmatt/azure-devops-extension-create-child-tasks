# Create Child Tasks

Quick links: [Overview](#overview) • [Quick Start](#quick-start) • [How-To](#how-to-guide) • [Examples](#examples) • [Troubleshooting](#troubleshooting) • [FAQ](#faq) • [Credits](#credits)

## Overview

Tired of manually creating the same set of child work items for each parent work item — what if you could generate them instantly with one click?

Create Child Tasks adds a toolbar action to Azure DevOps work items that instantly creates multiple child tasks (or any other child work item types) from a parent work item using team-defined Templates. Templates are matched by simple rules or JSON filters (type, state, title wildcards, tags, area/iteration, etc.), and the corresponding child work items are automatically created.

## Quick Start

1. Install the extension at your Azure DevOps organization (org-level install; once installed it is available to all projects in that organization / collection).
2. Define one or more Task templates for your team (Project Settings → Boards → Team Configuration → Templates).
3. Open a parent work item (User Story / PBI / Bug) and choose "Create Child Tasks" from the toolbar — child work items will be created from matching templates.

## How-To Guide

### Defining Task Templates
Create Task templates via Project Settings → Boards → Team Configuration → Templates. 

![ADO Project Team Templates](img/create-child-tasks-screenshot-manage-templates.png)

The template's Description is used for filtering rules. Two formats are supported:

- [Basic Filter](#basic-filter-simple): Square-bracket list of parent work item types. Example: [Product Backlog Item, Bug]
- [Advanced Filter](#advanced-filter-json): Single-line minified JSON with an applywhen array (see below)

![Team Templates - Description Field - Filter Rules](img/create-child-tasks-screenshot-manage-templates-filter-rules.png)

### Basic Filter (Simple)
Place a bracketed list of parent types in the template Description. This will apply the template for those parent types.
```
[Product Backlog Item, Bug]
```

### Advanced Filter (JSON)
Put a single-line JSON object containing an "applywhen" array into the template Description. Each entry in applywhen is evaluated as OR; fields inside an entry are combined as AND.

#### Example
```json
{
  "applywhen": [
    {
      "System.WorkItemType": "Product Backlog Item",
      "System.State": [ "New", "Approved" ],
      "System.BoardColumn": "Development",
      "System.BoardLane": "Expedite",
      "System.Title": "*Mobile*",
      "System.Tags": [ "Tag1", "Tag2" ],
      "System.AreaPath": "Project\\Area 1",
      "System.IterationPath": "Project\\Iteration\\Sprint 1"
    }
  ]
}
```
See the [Examples](#examples) section below for a more extensive set of filter examples.

#### Supported Fields

Currently supported filter fields (in template Description JSON):
- System.WorkItemType
- System.State
- System.BoardColumn
- System.BoardLane
- System.Title
- System.Tags
- System.AreaPath
- System.IterationPath

Notes:
- Multiple applywhen entries = OR (any entry matching will apply the template).
- Arrays = OR across values for that field.
- Title supports wildcards (*) and is case-insensitive.
- Tags as an array means all listed tags must be present (AND). For tag OR, add separate applywhen entries.
- AreaPath/IterationPath must match full path strings (case-insensitive). Escape backslashes in JSON (\\\\).
- Special token values in templates are supported: @me (AssignedTo), @currentiteration (IterationPath).

### Applying Child Work Items
- Open a parent work item.
- Select "Create Child Tasks" from the toolbar.
- The extension finds matching Work Item Templates and creates them as child work items.

![Create Child Work Items](img/create-child-tasks-screenshot-work-item-menu-item.png)

![Create Child Work Items - Results](img/create-child-tasks-screenshot-work-item-tasks.png)

### Ordering
By default, child work items are created in alphabetical order based on the Template *Name*. To control the creation order, prefix template names with numbers (for example, 01-, 02-).

![Work Item Templates Order - Prefix Template Names with Numbers](img/create-child-tasks-screenshot-manage-templates-order.png)

The child work items will be created in the same alphabetical order of the Template Name fields. Keep in mind, that the title of the child work item is derived by specifiying the System.Title field in the work item template – it is *not* derived from the Template Name.

![Work Item Templates Order - Results](img/create-child-tasks-screenshot-board-work-item-tasks.png)

### Wildcards for Title

You might want to apply a child work items to a parent work item if the parent work item title matches exactly or only partially. It's possible to match the parent work item title by using a wildcard filter rule and using the asterick character ("*").

```json
{
    "applywhen": [
    {
        "System.WorkItemType": "Product Backlog Item",
        "System.Title": "*WildcardString*"
    }]
}
```

The following are examples of how the wildcard matching can be used:
```
- "a*b"     Everything that starts with "a" and ends with "b"
- "a*"      Everything that starts with "a"
- "*b"      Everything that ends with "b"
- "*a*"     Everything that has an "a" in it
- "*a*b*"   Everything that has an "a" in it, followed by anything, followed by a "b", followed by anything
```

Note: Wildcard filter rules currently only work for the System.Title field.

---

## Examples

Template Description basic example:
```
[User Story, Bug]
```

Minimal JSON example (applies to User Story titles containing "integration"):
```json
{
  "applywhen": [
    {
      "System.WorkItemType": "User Story",
      "System.Title": "*integration*"
    }
  ]
}
```

Multiple rules (OR across rules, AND within rules):
```json
{
  "applywhen": [
    {
      "System.WorkItemType": "User Story",
      "System.State": "Approved"
    },
    {
      "System.WorkItemType": "User Story",
      "System.State": "Committed"
    },
    {
      "System.WorkItemType": "Bug",
      "System.Tags": ["Security"]
    }
  ]
}
```

Multiple rules (AND across rules, OR within rules)
```json
{
  "applywhen": [
    {
      "System.WorkItemType": ["Product Backlog Item", "User Story"],
      "System.State": ["New", "Approved", "Committed"],
      "System.BoardColumn": ["Backlog", "Ready"],
      "System.BoardLane": ["Default", "Expedite"],
      "System.Tags": ["Overdue", "Urgent"],
      "System.AreaPath": ["Project\\Area 1", "Project\\Area 2"],
      "System.IterationPath": ["Project\\Iteration\\Sprint 1", "Project\\Iteration\\Sprint 2"]
    }
  ]
}
```

---

## Troubleshooting

- No templates found:
  - Verify templates exist for the project team (Project → Boards → Templates) and are Task templates.
  - Templates are returned per team; ensure ctx.project.id and ctx.team.id correspond to the intended team.

- Tasks not created / permission errors:
  - Confirm you have permission to create work items in the target project.
  - Check browser console logs for error messages from the extension.

- Tags filter not matching:
  - Template tag filters require all listed tags (AND). Use multiple applywhen entries for OR.

- Iteration/Area not matching:
  - Use exact full path strings; escape backslashes in JSON (e.g., "Project\\\\Iteration\\\\Sprint 1").

---

## FAQ

Q: How do I match templates for multiple states or types?
A: Use arrays in the JSON for that field (e.g., "System.State":["Approved","Committed"]).

Q: Can I use wildcards on Area/Iteration?
A: No — AreaPath and IterationPath require exact full paths (case-insensitive).

Q: How do I make tags match either A or B?
A: Add multiple applywhen entries, one per tag, to produce an OR effect.

Q: How are AssignedTo and Iteration special tokens handled?
A: Use @me in a template field to assign to the current user; use @currentiteration to use the team's current iteration (handled at creation time).

Q: Can I enable the extension for only some projects?
A: No. Azure DevOps Services installs extensions at the organization level (Azure DevOps Server: collection level). They become available to all projects in that scope. To restrict usage you’d need to control permissions or uninstall/disable the extension at the org level.

Q: Why is the child work item title the same as the parent work item? How do I specify the title?
A: If the Task template does not define System.Title the extension copies the parent’s title. To set a custom title, add the System.Title field to the Task template with the desired text.

Q: What child work item types are supported?  
A: The extension supports creating *any* child work item type, not just Tasks. The available child types depend on how your process is configured in Azure DevOps Organization Process settings (Project Settings → Boards → Process → Backlog Levels). For example, you can use this extension to create Bugs, Features, or custom types as children, as long as they are defined as valid child types in your process/backlog configuration.

---

## Credits

Originally cloned from https://github.com/figueiredorui/1-click-child-links