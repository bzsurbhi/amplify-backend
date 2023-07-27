## API Report File for "@aws-amplify/client-config"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts

import { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { BackendIdentifier } from '@aws-amplify/plugin-types';

// @public
export type AuthClientConfig = {
    aws_cognito_region: string;
    aws_user_pools_id?: string;
    aws_user_pools_web_client_id?: string;
    aws_cognito_identity_pool_id?: string;
    aws_mandatory_sign_in?: string;
};

// @public
export type ClientConfig = Partial<AuthClientConfig & DataClientConfig & StorageClientConfig>;

// @public
export type DataClientConfig = {
    aws_appsync_region?: string;
    aws_appsync_graphqlEndpoint?: string;
    aws_appsync_authenticationType?: string;
    graphql_endpoint?: string;
    aws_appsync_apiKey?: string;
    graphql_endpoint_iam_region?: string;
};

// @public
export const generateClientConfig: (credentialProvider: AwsCredentialIdentityProvider, backendIdentifier: BackendIdentifier) => Promise<ClientConfig>;

// @public
export type StorageClientConfig = {
    aws_user_files_s3_bucket_region: string;
    aws_user_files_s3_bucket: string;
};

// (No @packageDocumentation comment for this package)

```