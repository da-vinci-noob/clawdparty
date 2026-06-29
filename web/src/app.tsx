import type { FC } from "react";
import { BrowserRouter } from "react-router-dom";
import { AppProvider } from "./providers/app_provider";
import { AppRoutes } from "./routes";

export const App: FC = () => (
  <AppProvider>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </AppProvider>
);
