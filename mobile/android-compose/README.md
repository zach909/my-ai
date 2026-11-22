# NeuroClaw Android (Kotlin + Jetpack Compose)

Native Android implementation of **NeuroClaw** — a local-first AI agent powered by the **OneBrain** neural mesh engine (`assets/onebrain/model.json`), raw UTF-8 byte-level Zip Loop encoding (zero tokenizers), hyperdimensional computing, NeuroLang skill building, Yes/No Doorway training, Danger Protocols, and an imported Android **DeviceTools** capability module.

## Core Architecture & Features

- **Local-First OneBrain Engine (`OneBrainEngine.kt`, `OneBrainModel.kt`, `HDVector.kt`)**:
  - **One model, one engine**: `OneBrainModel` holds everything OneBrain knows (byte graph, hyperdimensional mesh, Vale ledger, skill regions, memories, Yes/No examples) and is the only place it is loaded, merged and exported. `OneBrainEngine` is the only thing that runs it, and Chat's Yes/No hint and the Yes/No Trainer share a single scorer.
  - Loads bundled OneBrain byte-transition graph (`memory_input_b*` → `memory_output_b*`).
  - Encodes UTF-8 bytes directly into partitioned hyperdimensional vectors (`sem`, `ctx`, `val`, `tmp`, `meta`) with zero-sum Vale plasticity conservation across 32 hyper-neurons × 32 dimensions.
  - Consolidates surprise-gated associative memories and routes requests to active skill regions.
- **NeuroLang Builder, Store & Wiki (`NeuroLangParser.kt`, `BuilderScreen.kt`)**:
  - Compiles `name=`, `@vale=`, `@definition=`, and `@connections=` blocks directly on device, grafting new skill regions into OneBrain.
  - Includes a curated built-in Skill Store and offline Wiki.
- **Metrics & Yes/No Doorway (`MetricsScreen.kt`)**:
  - Live Vale distribution bars, OneBrain diagnostics, capability drills (Hyperdim, Vale, NeuroLang, ZipLoop), and on-device Yes/No classification training.
- **Commons, Alignment & DeviceTools (`CommonsScreen.kt`, `DeviceTools.kt`)**:
  - Danger Protocols alignment standing meter, Sandbox guard, Self-Healing checks, Data Donor toggles, and Compute Lending leases.
  - **DeviceTools** registered in OneBrain and runnable from Chat (`Tools` sheet or `tool: <name>`) or Commons: `permission_audit`, `device_info`, `network_status`, `battery_status`, `sensor_status`, `get_location`, `list_contacts`, `list_calendar_events`, `bluetooth_status`, `dial_number`, `compose_sms`, `compose_email`, `open_app_settings`, plus zero-permission Photo Picker (`PickVisualMedia`) and Document Picker (`OpenDocument`).
- **Warm Dark Coral + Crown Ring Ambient (`CrownRingAmbient.kt`)**:
  - Compose Canvas 2D 3D-projected 6-rise/6-dip Coral Crown Ring around the Shoggoth mascot with animated green skill tentacles for active mesh regions.
- **Optional PC Sync (`SyncClient.kt`, `SettingsScreen.kt`)**:
  - Everything runs locally on-device without a server; optionally connect to a NeuroClaw PC host via `/api/phone-sync` and `/api/captures`.
