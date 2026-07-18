import { expect } from "chai";
import * as sinon from "sinon";

import { command } from "./ailogic-triggers-list";
import * as ailogic from "../gcp/ailogic";
import * as projectUtils from "../projectUtils";
import { logger } from "../logger";
import { FirebaseError } from "../error";

const PROJECT_ID = "test-project";

describe("ailogic:triggers:list", () => {
  let listStub: sinon.SinonStub;
  let enabledStub: sinon.SinonStub;

  beforeEach(() => {
    (command as unknown as { befores: unknown[] }).befores = [];
    sinon.stub(projectUtils, "needProjectId").returns(PROJECT_ID);
    sinon.stub(logger, "info");
    enabledStub = sinon.stub(ailogic, "isAILogicApiEnabled").resolves(true);
    listStub = sinon.stub(ailogic, "listTriggers").resolves([]);
  });

  afterEach(() => sinon.restore());

  it("returns [] and does not call the API when AI Logic is not enabled", async () => {
    enabledStub.resolves(false);
    expect(await command.runner()({ project: PROJECT_ID })).to.deep.equal([]);
    expect(listStub).to.not.have.been.called;
  });

  it("returns the triggers when present", async () => {
    const triggers = [
      {
        name: "projects/p/locations/global/triggers/before",
        cloudFunction: { id: "fn", locationId: "us-central1" },
      },
    ];
    listStub.resolves(triggers);
    expect(await command.runner()({ project: PROJECT_ID })).to.deep.equal(triggers);
  });

  it("returns [] when there are no triggers", async () => {
    expect(await command.runner()({ project: PROJECT_ID })).to.deep.equal([]);
  });

  for (const status of [404, 501]) {
    it(`degrades gracefully (returns []) when the read API responds ${status}`, async () => {
      listStub.rejects(new FirebaseError("unavailable", { status }));
      expect(await command.runner()({ project: PROJECT_ID })).to.deep.equal([]);
    });
  }

  it("re-throws non-404/501 errors (e.g. permission denied)", async () => {
    listStub.rejects(new FirebaseError("permission denied", { status: 403 }));
    await expect(command.runner()({ project: PROJECT_ID })).to.be.rejectedWith(
      FirebaseError,
      /permission denied/,
    );
  });
});
