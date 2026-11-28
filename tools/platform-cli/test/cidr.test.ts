import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { caeSubnetCapacity, caeSubnetIpsNeeded, CONTAINER_APPS_RESERVED_RANGES, formatIpv4, parseCidr, rangeContains, rangesOverlap } from "../src/cidr.js";
import type { Ipv4Range } from "../src/cidr.js";

const range = (text: string): Ipv4Range => {
  const p = parseCidr(text);
  assert.ok(p.ok, `${text} parses`);
  return p.range;
};

describe("cidr: parseCidr", () => {
  it("reads the first and last address of a range, also above 2^31", () => {
    assert.deepEqual(range("10.20.0.0/25"), { text: "10.20.0.0/25", prefix: 25, start: 169_082_880, end: 169_083_007 });
    const high = range("192.168.255.0/24");
    assert.equal(formatIpv4(high.start), "192.168.255.0");
    assert.equal(formatIpv4(high.end), "192.168.255.255");
    const all = range("0.0.0.0/0");
    assert.equal(all.end - all.start + 1, 2 ** 32);
    const last = range("255.255.255.255/32");
    assert.equal(last.start, last.end);
    assert.equal(last.start, 2 ** 32 - 1);
  });

  it("refuses what is not an IPv4 range, host bits included, with the reason", () => {
    const why = (text: string): string => {
      const p = parseCidr(text);
      assert.equal(p.ok, false, text);
      return p.ok ? "" : p.message;
    };
    assert.match(why("10.20.0.0"), /is not an IPv4 range in CIDR notation/);
    assert.match(why("10.20.0/24"), /is not an IPv4 range in CIDR notation/);
    assert.match(why("10.20.0.256/24"), /an address part is above 255/);
    assert.match(why("10.20.0.0/33"), /prefix length is above 32/);
    assert.equal(why("10.20.0.1/24"), '"10.20.0.1/24" has host bits set; the network address of that range is 10.20.0.0/24.');
    assert.equal(why("10.20.1.0/23"), '"10.20.1.0/23" has host bits set; the network address of that range is 10.20.0.0/23.');
    assert.equal(why("255.255.255.255/31"), '"255.255.255.255/31" has host bits set; the network address of that range is 255.255.255.254/31.');
  });
});

describe("cidr: overlap and containment", () => {
  it("ranges overlap when one contains the other or they share addresses, not when they touch", () => {
    assert.equal(rangesOverlap(range("10.20.0.0/24"), range("10.20.0.128/25")), true);
    assert.equal(rangesOverlap(range("10.20.0.128/25"), range("10.20.0.0/24")), true);
    assert.equal(rangesOverlap(range("10.20.0.0/24"), range("10.20.0.0/24")), true);
    assert.equal(rangesOverlap(range("10.20.0.0/24"), range("10.20.1.0/24")), false);
    assert.equal(rangesOverlap(range("10.20.0.0/25"), range("10.20.0.128/25")), false);
    assert.equal(rangesOverlap(range("0.0.0.0/1"), range("128.0.0.0/1")), false);
  });

  it("containment is directional", () => {
    assert.equal(rangeContains(range("10.20.0.0/23"), range("10.20.1.0/24")), true);
    assert.equal(rangeContains(range("10.20.1.0/24"), range("10.20.0.0/23")), false);
    assert.equal(rangeContains(range("10.20.0.0/24"), range("10.20.0.0/24")), true);
    assert.equal(rangeContains(range("10.20.0.0/24"), range("10.21.0.0/24")), false);
  });

  it("the reserved ranges are the ones network-modes.md names, all valid and disjoint", () => {
    assert.deepEqual([...CONTAINER_APPS_RESERVED_RANGES], [
      "169.254.0.0/16",
      "172.30.0.0/16",
      "172.31.0.0/16",
      "192.0.2.0/24",
      "100.100.0.0/17",
      "100.100.128.0/19",
      "100.100.160.0/19",
      "100.100.192.0/19",
    ]);
    const ranges = CONTAINER_APPS_RESERVED_RANGES.map(range);
    ranges.forEach((a, i) => ranges.slice(i + 1).forEach((b) => assert.equal(rangesOverlap(a, b), false, `${a.text} ${b.text}`)));
  });
});

describe("cidr: CAE subnet capacity (network-modes.md#sizing)", () => {
  it("matches the capacity table of the Microsoft documentation, as the spike recorded it", () => {
    assert.deepEqual(caeSubnetCapacity(27), { addresses: 32, usable: 18, maxReplicas: 90 });
    assert.deepEqual(caeSubnetCapacity(26), { addresses: 64, usable: 50, maxReplicas: 250 });
    assert.deepEqual(caeSubnetCapacity(25), { addresses: 128, usable: 114, maxReplicas: 570 });
    assert.deepEqual(caeSubnetCapacity(24), { addresses: 256, usable: 242, maxReplicas: 1210 });
  });

  it("a subnet below the /27 minimum holds nothing", () => {
    assert.equal(caeSubnetCapacity(28).maxReplicas, 0);
    assert.equal(caeSubnetCapacity(32).usable, 0);
  });

  it("the IPs needed are 14 + 2 x ceil(sum / 10), and a subnet holds exactly its capacity", () => {
    assert.equal(caeSubnetIpsNeeded(0), 14);
    assert.equal(caeSubnetIpsNeeded(300), 74); // the spike's example: 60 apps x 5 replicas -> /25
    assert.equal(caeSubnetIpsNeeded(180), 50); // 60 apps x 3 replicas -> exactly a /26
    for (const prefix of [27, 26, 25, 24, 23]) {
      const { addresses, maxReplicas } = caeSubnetCapacity(prefix);
      assert.ok(caeSubnetIpsNeeded(maxReplicas) <= addresses, `/${prefix} holds its capacity`);
      assert.ok(caeSubnetIpsNeeded(maxReplicas + 1) > addresses, `/${prefix} holds nothing more`);
    }
  });
});
