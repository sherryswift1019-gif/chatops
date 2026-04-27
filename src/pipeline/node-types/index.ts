// node-types/index.ts
// Registry entry point for pipeline node type executors.
// Import this file to trigger self-registration of all node type executors.
//
// V1: The node type system is being built incrementally. This file currently
// serves as the import side-effect trigger for future node type registration.
// Imported by dryrun-wrapper tests to simulate production import ordering.
