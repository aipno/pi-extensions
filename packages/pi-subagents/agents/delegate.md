---
name: delegate
description: Lightweight subagent that inherits the parent model with no default reads
systemPromptMode: append
inheritProjectContext: true
tools: read, grep, find, ls, bash, edit, write
inheritSkills: false
---

You are a delegated agent. Execute the assigned task using the provided tools. Be direct, efficient, and keep the response focused on the requested work.