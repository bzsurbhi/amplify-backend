import { IConstruct } from 'constructs';
import {
  AmplifyFunction,
  AuthResources,
  BackendOutputStorageStrategy,
  ConstructContainerEntryGenerator,
  ConstructFactory,
  ConstructFactoryGetInstanceProps,
  GenerateContainerEntryProps,
  ResourceProvider,
} from '@aws-amplify/plugin-types';
import {
  AmplifyData,
  AmplifyDynamoDbTableWrapper,
  TranslationBehavior,
} from '@aws-amplify/data-construct';
import { GraphqlOutput } from '@aws-amplify/backend-output-schemas';
import * as path from 'path';
import { AmplifyDataError, DataProps } from './types.js';
import { convertSchemaToCDK, isModelSchema } from './convert_schema.js';
import { convertFunctionNameMapToCDK } from './convert_functions.js';
import {
  ProvidedAuthConfig,
  buildConstructFactoryProvidedAuthConfig,
  convertAuthorizationModesToCDK,
  isUsingDefaultApiKeyAuth,
} from './convert_authorization_modes.js';
import { validateAuthorizationModes } from './validate_authorization_modes.js';
import { AmplifyUserError, CDKContextKey } from '@aws-amplify/platform-core';
import { Aspects, IAspect } from 'aws-cdk-lib';
import { convertJsResolverDefinition } from './convert_js_resolvers.js';
import { AppSyncPolicyGenerator } from './app_sync_policy_generator.js';
import {
  FunctionSchemaAccess,
  JsResolver,
} from '@aws-amplify/data-schema-types';

/**
 * Singleton factory for AmplifyGraphqlApi constructs that can be used in Amplify project files.
 *
 * Exported for testing purpose only & should NOT be exported out of the package.
 */
export class DataFactory implements ConstructFactory<AmplifyData> {
  // publicly accessible for testing purpose only.
  static factoryCount = 0;

  private generator: ConstructContainerEntryGenerator;

  /**
   * Create a new AmplifyConstruct
   */
  constructor(
    private readonly props: DataProps,
    private readonly importStack = new Error().stack
  ) {
    if (DataFactory.factoryCount > 0) {
      throw new AmplifyUserError('MultipleSingletonResourcesError', {
        message:
          'Multiple `defineData` calls are not allowed within an Amplify backend',
        resolution: 'Remove all but one `defineData` call',
      });
    }
    DataFactory.factoryCount++;
  }

  /**
   * Gets an instance of the Data construct
   */
  getInstance = (props: ConstructFactoryGetInstanceProps): AmplifyData => {
    const { constructContainer, outputStorageStrategy, importPathVerifier } =
      props;
    importPathVerifier?.verify(
      this.importStack,
      path.join('amplify', 'data', 'resource'),
      'Amplify Data must be defined in amplify/data/resource.ts'
    );
    if (!this.generator) {
      this.generator = new DataGenerator(
        this.props,
        buildConstructFactoryProvidedAuthConfig(
          props.constructContainer
            .getConstructFactory<ResourceProvider<AuthResources>>(
              'AuthResources'
            )
            ?.getInstance(props)
        ),
        props,
        outputStorageStrategy
      );
    }
    return constructContainer.getOrCompute(this.generator) as AmplifyData;
  };
}

class DataGenerator implements ConstructContainerEntryGenerator {
  readonly resourceGroupName = 'data';
  private readonly defaultName = 'amplifyData';

  constructor(
    private readonly props: DataProps,
    private readonly providedAuthConfig: ProvidedAuthConfig | undefined,
    private readonly getInstanceProps: ConstructFactoryGetInstanceProps,
    private readonly outputStorageStrategy: BackendOutputStorageStrategy<GraphqlOutput>
  ) {}

  generateContainerEntry = ({
    scope,
    ssmEnvironmentEntriesGenerator,
  }: GenerateContainerEntryProps) => {
    let amplifyGraphqlDefinition;
    let jsFunctions: JsResolver[] = [];
    let functionSchemaAccess: FunctionSchemaAccess[] = [];
    let lambdaFunctions: Record<string, ConstructFactory<AmplifyFunction>> = {};
    try {
      if (isModelSchema(this.props.schema)) {
        ({ jsFunctions, functionSchemaAccess, lambdaFunctions } =
          this.props.schema.transform());
      }
      amplifyGraphqlDefinition = convertSchemaToCDK(this.props.schema);
    } catch (error) {
      throw new AmplifyUserError<AmplifyDataError>(
        'InvalidSchemaError',
        {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to parse schema definition.',
          resolution:
            'Check your data schema definition for syntax and type errors.',
        },
        error instanceof Error ? error : undefined
      );
    }

    let authorizationModes;

    /**
     * TODO - remove this after the data construct does work to remove the need for allow-listed IAM roles
     */
    const functionSchemaAccessRoles = functionSchemaAccess.map(
      (accessEntry) =>
        accessEntry.resourceProvider.getInstance(this.getInstanceProps)
          .resources.lambda.role!
    );

    try {
      authorizationModes = convertAuthorizationModesToCDK(
        this.getInstanceProps,
        this.providedAuthConfig,
        this.props.authorizationModes,
        functionSchemaAccessRoles
      );
    } catch (error) {
      throw new AmplifyUserError<AmplifyDataError>(
        'InvalidSchemaAuthError',
        {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to parse authorization modes.',
          resolution: 'Ensure the auth rules on your schema are valid.',
        },
        error instanceof Error ? error : undefined
      );
    }

    try {
      validateAuthorizationModes(
        this.props.authorizationModes,
        authorizationModes
      );
    } catch (error) {
      throw new AmplifyUserError<AmplifyDataError>(
        'InvalidSchemaAuthError',
        {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to validate authorization modes',
          resolution: 'Ensure the auth rules on your schema are valid.',
        },
        error instanceof Error ? error : undefined
      );
    }

    const sandboxModeEnabled = isUsingDefaultApiKeyAuth(
      this.providedAuthConfig,
      this.props.authorizationModes
    );

    const propsFunctions = this.props.functions ?? {};

    const functionNameMap = convertFunctionNameMapToCDK(this.getInstanceProps, {
      ...propsFunctions,
      ...lambdaFunctions,
    });
    const amplifyApi = new AmplifyData(scope, this.defaultName, {
      apiName: this.props.name,
      definition: amplifyGraphqlDefinition,
      authorizationModes,
      outputStorageStrategy: this.outputStorageStrategy,
      functionNameMap,
      translationBehavior: {
        sandboxModeEnabled,
        /**
         * The destructive updates should be always allowed in backend definition and not to be controlled on the IaC
         * The CI/CD check should take the responsibility to validate if any tables are being replaced and determine whether to execute the changeset
         */
        allowDestructiveGraphqlSchemaUpdates: true,
      },
    });

    /**
     * Enable the table replacement upon GSI update
     * This is allowed in sandbox mode ONLY
     */
    const isSandboxDeployment =
      scope.node.tryGetContext(CDKContextKey.DEPLOYMENT_TYPE) === 'sandbox';
    if (isSandboxDeployment) {
      Aspects.of(amplifyApi).add(new ReplaceTableUponGsiUpdateOverrideAspect());
    }

    convertJsResolverDefinition(scope, amplifyApi, jsFunctions);

    const ssmEnvironmentEntries =
      ssmEnvironmentEntriesGenerator.generateSsmEnvironmentEntries({
        [`${this.props.name}_GRAPHQL_ENDPOINT`]:
          amplifyApi.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl,
      });

    const policyGenerator = new AppSyncPolicyGenerator(
      amplifyApi.resources.graphqlApi
    );

    functionSchemaAccess.forEach((accessDefinition) => {
      const policy = policyGenerator.generateGraphqlAccessPolicy(
        accessDefinition.actions
      );
      accessDefinition.resourceProvider
        .getInstance(this.getInstanceProps)
        .getResourceAccessAcceptor()
        .acceptResourceAccess(policy, ssmEnvironmentEntries);
    });

    return amplifyApi;
  };
}

const REPLACE_TABLE_UPON_GSI_UPDATE_ATTRIBUTE_NAME: keyof TranslationBehavior =
  'replaceTableUponGsiUpdate';

/**
 * Aspect class to modify the amplify managed DynamoDB table
 * to allow table replacement upon GSI update
 */
class ReplaceTableUponGsiUpdateOverrideAspect implements IAspect {
  public visit(scope: IConstruct): void {
    if (AmplifyDynamoDbTableWrapper.isAmplifyDynamoDbTableResource(scope)) {
      // These value setters are not exposed in the wrapper
      // Need to use the property override to escape the hatch
      scope.addPropertyOverride(
        REPLACE_TABLE_UPON_GSI_UPDATE_ATTRIBUTE_NAME,
        true
      );
    }
  }
}

/**
 * Creates a factory that implements ConstructFactory<AmplifyGraphqlApi>
 */
export const defineData = (props: DataProps): ConstructFactory<AmplifyData> =>
  new DataFactory(props, new Error().stack);
