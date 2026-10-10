// riscv-tests and random programs on the single-cycle CPUs (tests/verify/suite.ts).
import { verifyCpus } from './verify/suite';

verifyCpus(['sc', 'sc-ks', 'sc-dc', 'sc-wb2', 'sc-ic', 'sc-wb-ic']);
