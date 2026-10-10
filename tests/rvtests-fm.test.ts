// The official riscv-tests on the F and M CPUs (tests/verify/suite.ts).
import { riscvTests } from './verify/suite';

riscvTests(['sc-f', 'fppipe', 'pipe-m', 'pipe-m-bal-bp']);
