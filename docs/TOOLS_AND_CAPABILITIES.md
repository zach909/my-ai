# Tools and Capabilities Reference

A reference list of the tools and capabilities available to the Claude agent working in this repository's sandbox. This describes the agent's tooling, not the project's own code. Everything here is a tool the agent calls. None of it is vendored or imported into the project, so the no-third-party rule in `CLAUDE.md` is unaffected.

## Workspace (Linux sandbox)
- Bash, Read, Write, Edit, NotebookEdit
- SendUserFile, SendUserMessage

## Research and web
- WebSearch, WebFetch, image_search
- launch_extended_search_task, read_research_report

## Browser and computer control
- Claude in Chrome: navigate, read_page, get_page_text, find, computer, form_input, javascript_tool, gif_creator, read_console_messages, read_network_requests, tabs_*, resize_window, file_upload, upload_image
- Built-in browser and computer use (both need enabling first)

## Orchestration
- Agent (subagents), Skill, ToolSearch
- TaskCreate, TaskUpdate, TaskGet, TaskList, TaskStop, Monitor
- EnterPlanMode, ExitPlanMode, AskUserQuestion
- PushNotification, SendMessage, ReadNotifications

## Scheduling
- create_trigger, send_later, list_triggers, update_trigger, fire_trigger, delete_trigger

## Repos
- add_repo, list_repos, register_repo_root

## Memory and past chats
- memory_read, memory_write, memory_str_replace, memory_append, memory_list, memory_delete
- conversation_search, recent_chats, read_conversation

## Artifacts and docs (built in)
- Artifacts: publish, edit, read, list types, create from type, files, assets, comments, db
- Claude Docs: create, read, update, query, export

## Visuals
- Visualizer: read_me, show_widget (inline SVG/HTML)
- chart_display, quiz, recipe, step_card, options_card, translation, link_preview, message_compose
- weather, places_search, places_map, places_list, fetch_sports_data

## Phone (device)
- alarm, timer, calendar events, location, chart display

## Discovery
- SearchMcpRegistry, SuggestConnectors, SearchPlugins, SuggestSkills
- ListConnectors, ListPlugins, ListSkills, SearchSkills
- RefreshMcpTools, ListMcpResources, ReadMcpResource

## Misc
- current_time, approximate_location, us_election_info
- show_recommendation_cards, propose_skills, ReportFindings
- end_conversation

## Skills
- Files: docx, xlsx, pptx, pdf, pdf-reading
- Build/design: frontend-design, dataviz, video-making, skill-creator
- Platform: deep-research, import-memory, ~15 Hugging Face skills
- Plugin and mod authoring

## Blocked or limited
- Denied: comparison, featured, itinerary, product carousel widgets
- Plugin install cards don't render on mobile
- Replit and monday.com need authentication
- Several tools are deferred (schemas load on demand)
