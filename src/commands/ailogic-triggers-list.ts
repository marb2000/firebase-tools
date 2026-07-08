import { Command } from "../command";
import { requirePermissions } from "../requirePermissions";
import { needProjectId } from "../projectUtils";
import * as ailogic from "../gcp/ailogic";
import * as clc from "colorette";
import { logger } from "../logger";
import { getErrStatus } from "../error";
import * as Table from "cli-table3";

import { Options } from "../options";

export const command = new Command("ailogic:triggers:list")
  .description("list registered triggers")
  .before(requirePermissions, ["firebasevertexai.triggers.get"])
  .action(async (options: Options) => {
    const projectId = needProjectId(options);
    if (!(await ailogic.isAILogicApiEnabled(projectId))) {
      logger.info(clc.bold("Firebase AI Logic is not enabled on this project."));
      return [];
    }

    let triggers;
    try {
      triggers = await ailogic.listTriggers(projectId, "global");
    } catch (err: unknown) {
      // The trigger registration read surface is not yet exposed in the public
      // v1beta API. Until it ships, the collection endpoint returns not-found /
      // not-implemented; degrade gracefully rather than surfacing a raw error.
      // Any other status (e.g. permissions) is a real error and is re-thrown.
      const status = getErrStatus(err);
      if (status === 404 || status === 501) {
        logger.info(clc.yellow("Listing AI Logic triggers is not yet available for this project."));
        return [];
      }
      throw err;
    }

    if (triggers.length === 0) {
      logger.info(clc.bold("No registered triggers found."));
      return triggers;
    }

    const tableHead = ["Trigger ID", "Function ID", "Function Region"];
    const table = new Table({ head: tableHead, style: { head: ["green"] } });

    for (const t of triggers) {
      const triggerId = t.name.split("/").pop() || "";
      table.push([
        clc.bold(triggerId),
        t.cloudFunction?.id || "",
        t.cloudFunction?.locationId || "",
      ]);
    }

    logger.info(table.toString());
    return triggers;
  });
