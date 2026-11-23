import { expect } from "chai";
import { InFlightGuard } from "src/in-flight";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("InFlightGuard", () => {
  it("rejects a second run for the same key until the first completes", async () => {
    const guard = new InFlightGuard();
    const first = deferred();
    let calls = 0;
    const p1 = guard.run("note.md", () => {
      calls++;
      return first.promise;
    });
    expect(p1).to.exist;
    expect(guard.isRunning("note.md")).to.be.true;
    expect(guard.run("note.md", async () => { calls++; })).to.be.undefined;
    expect(calls).to.equal(1);

    first.resolve();
    await p1;
    expect(guard.isRunning("note.md")).to.be.false;
    await guard.run("note.md", async () => { calls++; });
    expect(calls).to.equal(2);
  });

  it("allows different keys concurrently", async () => {
    const guard = new InFlightGuard();
    const a = deferred();
    const pa = guard.run("a.md", () => a.promise);
    const pb = guard.run("b.md", async () => "b");
    expect(pa).to.exist;
    expect(await pb).to.equal("b");
    a.resolve();
    await pa;
  });

  it("releases the key when the operation fails (async or sync)", async () => {
    const guard = new InFlightGuard();
    await guard.run("x", async () => { throw new Error("boom"); })!.should.be.rejectedWith("boom");
    expect(guard.isRunning("x")).to.be.false;
    expect(() => guard.run("x", () => { throw new Error("sync"); })).to.throw("sync");
    expect(guard.isRunning("x")).to.be.false;
  });
});
