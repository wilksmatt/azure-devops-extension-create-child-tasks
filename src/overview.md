# Create Child Tasks

Quick links: [Overview](#overview) • [Quick Start](#quick-start) • [How-To](#how-to-guide) • [Examples](#examples) • [Troubleshooting](#troubleshooting) • [FAQ](#faq) • [Credits](#credits)

## Overview

Tired of manually creating the same set of child work items for each parent work item — what if you could generate them instantly from team-defined templates?

Create Child Tasks adds a toolbar action to Azure DevOps work items that instantly creates multiple child tasks (or any other child work item types) from a parent work item using team-defined Templates. Templates are matched by simple rules or JSON filters (type, state, title wildcards, tags, area/iteration, etc.), and the corresponding child work items are automatically created.

## Quick Start

1. Install the extension at your Azure DevOps organization (org-level install; once installed it is available to all projects in that organization / collection).
2. Define one or more Task templates for your team (Project Settings → Boards → Team Configuration → Templates).
3. Open a parent work item (User Story / PBI / Bug) and choose "Create Child Tasks" from the toolbar — child work items will be created from matching templates.

## How-To Guide

### Defining Task Templates
Create Task templates via Project Settings → Boards → Team Configuration → Templates. 

![ADO Project Task Templates](img/create-child-tasks-screenshot-manage-templates.png)

The template's Description is used for filtering rules. Two formats are supported:

- [Basic Filter](#basic-filter-simple): Square-bracket list of parent work item types. Example: [Product Backlog Item, Bug]
- [Advanced Filter](#advanced-filter-json): Single-line minified JSON with an applywhen array (see below)

### Basic Filter (Simple)
Place a bracketed list of parent types in the template Description. This will apply the template for those parent types.
```
[Product Backlog Item, Bug]
```

### Advanced Filter (JSON)
Put a single-line JSON object containing an "applywhen" array into the template Description. Each entry in applywhen is evaluated as OR; fields inside an entry are combined as AND.

Ready-to-copy example:
```json
{"applywhen":[{"System.WorkItemType":["Product Backlog Item","Bug"],"System.State":["Approved","Committed"],"System.Title":"*API*","System.Tags":["Security","Backend"],"System.AreaPath":["Project\\\\Area Path"],"System.IterationPath":["Project\\\\Iteration\\\\Sprint 1"]}]}
```

Key behaviors:
- Arrays = OR across values for that field.
- Title supports wildcards (*) and is case-insensitive.
- Tags as an array means all listed tags must be present (AND). For tag OR, add separate applywhen entries.
- Multiple applywhen entries = OR (any entry matching will apply the template).

### Supported fields & limitations (summary)

Supported filter fields (in template Description JSON):
- System.WorkItemType, System.State, System.BoardColumn, System.BoardLane, System.Title, System.Tags, System.AreaPath, System.IterationPath

Notes:
- System.Tags in filters requires all listed tags (AND). Use multiple rules for OR.
- AreaPath/IterationPath must match full path strings (case-insensitive). Escape backslashes in JSON (\\).
- Wildcards supported for System.Title only (use * characters).
- Special token values in templates supported: @me (AssignedTo), @currentiteration (IterationPath). See examples.

### Applying Child Tasks
- Open a parent work item.
- Select "Create Child Tasks" from the toolbar.
- The extension finds matching Task templates and creates child Tasks in alphabetical order by template name (prefix names with numbers to control order).

### Ordering
- Templates are sorted alphabetically by name before creation. Use numeric prefixes (01-, 02-) to control ordering.

### Wildcards for Title
- Use "*" as wildcard in System.Title values (e.g. "*Integration*", "bug *", "API*").

---

## Examples

Minimal JSON example (applies to User Story titles containing "integration"):
```json
{"applywhen":[{"System.WorkItemType":"User Story","System.Title":"*integration*"}]}
```

Multiple rules (OR across rules, AND within rules):
```json
{"applywhen":[{"System.WorkItemType":"User Story","System.State":["Approved","Committed"]},{"System.WorkItemType":"Bug","System.Tags":"Security"}]}
```

Template Description basic example:
[User Story, Bug]

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

How to diagnose:
- Open browser DevTools console inside the work item iframe to inspect logs.
- For local testing with webpack dev server, ensure the dev override points to your local baseUri and trust the self-signed cert.

---

## FAQ

- Q: How do I match templates for multiple states or types?
- A: Use arrays in the JSON for that field (e.g., "System.State":["Approved","Committed"]).

- Q: Can I use wildcards on Area/Iteration?
- A: No — AreaPath and IterationPath require exact full paths (case-insensitive).

- Q: How do I make tags match either A or B?
- A: Add multiple applywhen entries, one per tag, to produce an OR effect.

- Q: How are AssignedTo and Iteration special tokens handled?
- A: Use @me in a template field to assign to the current user; use @currentiteration to use the team's current iteration (handled at creation time).

- Q: Can I enable the extension for only some projects?
- A: No. Azure DevOps Services installs extensions at the organization level (Azure DevOps Server: collection level). They become available to all projects in that scope. To restrict usage you’d need to control permissions or uninstall/disable the extension at the org level.

- Q: Why is the child work item title the same as the parent work item? How do I specify the title?
- A: If the Task template does not define System.Title the extension copies the parent’s title. To set a custom title, add the System.Title field to the Task template with the desired text.

---

## Examples & Tips

- Control order: prefix names with numbers.
- Use extractable fields in template body via {FieldName} references (e.g., {System.Title}) to copy values from parent into template fields.

---

## Credits

Originally cloned from https://github.com/figueiredorui/1-click-child-links