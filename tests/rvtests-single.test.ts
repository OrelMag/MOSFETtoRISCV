// The official riscv-tests on the single-cycle CPUs (tests/verify/suite.ts).
import { riscvTests } from './verify/suite';

riscvTests(['sc', 'sc-ks', 'sc-dc', 'sc-wb2', 'sc-ic', 'sc-wb-ic']);
