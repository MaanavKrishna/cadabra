import { App } from 'aws-cdk-lib';
import { CadabraStack } from './stack';

const app = new App();
new CadabraStack(app, 'CadabraBackend', {
  env: { account: '380794909728', region: 'ap-south-1' },
});
