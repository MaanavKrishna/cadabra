import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export class CadabraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const assets = new Bucket(this, 'Assets', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const site = new Bucket(this, 'ControllerSite', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const cdn = new Distribution(this, 'ControllerCdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    const reserved = Number(this.node.tryGetContext('reservedConcurrency') ?? 20);
    const fn = new NodejsFunction(this, 'WsFn', {
      entry: fileURLToPath(new URL('../src/handlers/ws.ts', import.meta.url)),
      handler: 'handler',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      // Cap blast radius; set -c reservedConcurrency=0 on low-quota accounts to skip.
      reservedConcurrentExecutions: reserved > 0 ? reserved : undefined,
      environment: { TABLE_NAME: table.tableName },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });
    // Least privilege: only the item operations the handler uses.
    table.grant(fn, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:Query');

    const integ = new WebSocketLambdaIntegration('WsInteg', fn);
    const api = new WebSocketApi(this, 'WsApi', {
      connectRouteOptions: { integration: integ },
      disconnectRouteOptions: { integration: integ },
      defaultRouteOptions: { integration: integ },
    });
    const stage = new WebSocketStage(this, 'Prod', { webSocketApi: api, stageName: 'prod', autoDeploy: true });
    (stage.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50, throttlingBurstLimit: 100,
    };
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [this.formatArn({
        service: 'execute-api', resource: api.apiId, resourceName: `${stage.stageName}/POST/@connections/*`,
      })],
    }));

    new CfnOutput(this, 'WsUrl', { value: stage.url });
    new CfnOutput(this, 'ControllerUrl', { value: `https://${cdn.distributionDomainName}` });
    new CfnOutput(this, 'ControllerBucket', { value: site.bucketName });
    new CfnOutput(this, 'ControllerDistributionId', { value: cdn.distributionId });
    new CfnOutput(this, 'AssetsBucket', { value: assets.bucketName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
