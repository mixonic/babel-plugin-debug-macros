import { FEATURE_A, FEATURE_B } from '@ember/features';

let a;
if (FEATURE_A) {
  a = () => console.log('hello');
} else if (FEATURE_B) {
  a = () => console.log('bye');
}
