---
name: git-diff
description: Skill for displaying and analyzing git diffs in the workspace. Use when users want to see differences between commits, branches, or working directory changes, such as comparing branches, viewing unstaged changes, or reviewing commit differences.
license: Complete terms in LICENSE.txt
---

# Git Diff

This skill provides functionality to display and analyze git differences in the current workspace.

## Usage

When the user requests to see git diffs, use the appropriate git diff commands to show the differences.

### Common Scenarios

1. **View unstaged changes**: `git diff`
2. **View staged changes**: `git diff --staged`
3. **Compare branches**: `git diff branch1..branch2`
4. **Compare commits**: `git diff commit1..commit2`
5. **View changes in a specific file**: `git diff <file>`

## Instructions

- Always run git commands in the workspace root directory.
- Display the output clearly, using code blocks for diff output.
- If the diff is very large, consider using `git diff --stat` first for an overview, then show specific parts if requested.
- Explain what the diff shows: added lines (+), removed lines (-), and context.

## Output Format

Present diffs in markdown code blocks with appropriate language highlighting if possible.

Example:

```diff
diff --git a/file.txt b/file.txt
index 1234567..abcdef0 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
 line 2
+new line
 line 3
```
