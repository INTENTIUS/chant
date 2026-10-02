import { EventsTable } from "./events-table";

export const pageViews = EventsTable({ name: "page_views", ttlDays: 30 });
