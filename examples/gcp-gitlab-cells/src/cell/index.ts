import { createCell } from "./factory";
import { cells } from "../config";

export const cellResources = cells.map(c => createCell(c));
