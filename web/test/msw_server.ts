import { setupServer } from "msw/node";

// The shared MSW server instance. W2 feature tests add handlers via
// `server.use(...)`; W1 ships it empty as the convention seam.
export const server = setupServer();
